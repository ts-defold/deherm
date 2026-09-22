import path from "node:path";

import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type Executable,
  type LanguageClientOptions,
  type ServerOptions
} from "vscode-languageclient/node.js";

import {
  debugAdapterLaunch,
  languageServerLaunch,
  owningDehermProject,
  resolveDehermCli,
  selectDehermProject,
  type DehermProject
} from "./core.js";

const ignoredProjectDirectories = "**/{.git,.deherm,.internal,node_modules,build,dist}/**";

class ProjectRegistry {
  private projects: DehermProject[] = [];

  async refresh(): Promise<readonly DehermProject[]> {
    const discovered: DehermProject[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "**/game.project"),
        ignoredProjectDirectories,
        64
      );
      for (const file of files) {
        discovered.push({ projectRoot: path.dirname(file.fsPath), workspaceRoot: folder.uri.fsPath });
      }
    }
    this.projects = discovered.sort((left, right) => left.projectRoot.localeCompare(right.projectRoot));
    return this.projects;
  }

  all(): readonly DehermProject[] {
    return this.projects;
  }

  select(requestedProject: string | undefined, folder: vscode.WorkspaceFolder | undefined): DehermProject {
    return selectDehermProject({
      projects: this.projects,
      requestedProject,
      workspaceRoot: folder?.uri.fsPath
    });
  }
}

class DehermClients {
  private readonly clients = new Map<string, LanguageClient>();
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private operation: Promise<void> = Promise.resolve();
  private lastFailureCount = 0;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly projects: ProjectRegistry
  ) {}

  private configuredCli(project: DehermProject): string | undefined {
    return vscode.workspace.getConfiguration("deherm", vscode.Uri.file(project.projectRoot)).get<string>("cliPath") || undefined;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.operation.then(operation);
    this.operation = current.catch(() => {});
    return current;
  }

  private async replaceAll(showErrors: boolean): Promise<void> {
    await this.stopCurrent();
    this.lastFailureCount = 0;
    for (const project of await this.projects.refresh()) {
      try {
        const cliPath = await resolveDehermCli({
          projectRoot: project.projectRoot,
          workspaceRoot: project.workspaceRoot,
          configuredPath: this.configuredCli(project)
        });
        const nodeExecutable = vscode.workspace.getConfiguration("deherm", vscode.Uri.file(project.projectRoot)).get<string>("nodePath") || undefined;
        const launch = languageServerLaunch({ cliPath, projectRoot: project.projectRoot, nodeExecutable });
        const executable: Executable = {
          command: launch.command,
          args: [...launch.args],
          options: { cwd: launch.cwd, env: { ...launch.env } },
          transport: TransportKind.stdio
        };
        const serverOptions: ServerOptions = { run: executable, debug: executable };
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.projectRoot));
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
          project.projectRoot,
          "{game.project,**/*.{collection,go,gui,atlas,tilesource,tilemap,material,font,script_api},.deherm/extensions.json,.deherm/generated/*.json}"
        ));
        this.watchers.set(project.projectRoot, watcher);
        const clientOptions: LanguageClientOptions = {
          workspaceFolder,
          documentSelector: [
            { scheme: "file", language: "typescript" },
            { scheme: "file", language: "typescriptreact" }
          ],
          middleware: {
            provideCompletionItem: (document, position, context, token, next) =>
              owningDehermProject(this.projects.all(), document.uri.fsPath)?.projectRoot === project.projectRoot
                ? next(document, position, context, token)
                : null,
            provideHover: (document, position, token, next) =>
              owningDehermProject(this.projects.all(), document.uri.fsPath)?.projectRoot === project.projectRoot
                ? next(document, position, token)
                : null,
            provideDefinition: (document, position, token, next) =>
              owningDehermProject(this.projects.all(), document.uri.fsPath)?.projectRoot === project.projectRoot
                ? next(document, position, token)
                : null
          },
          synchronize: { fileEvents: watcher },
          outputChannel: this.output,
          initializationOptions: {
            projectRoot: project.projectRoot,
            generatedRoot: path.join(project.projectRoot, ".deherm")
          }
        };
        const id = `deherm-${Buffer.from(project.projectRoot).toString("hex")}`;
        const client = new LanguageClient(id, `déherm (${path.basename(project.projectRoot)})`, serverOptions, clientOptions);
        this.clients.set(project.projectRoot, client);
        await client.start();
      } catch (error) {
        this.lastFailureCount += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`Could not start déherm for ${project.projectRoot}: ${message}`);
        if (showErrors) void vscode.window.showErrorMessage(`déherm: ${message}`);
      }
    }
  }

  startAll(showErrors = false): Promise<void> {
    return this.enqueue(() => this.replaceAll(showErrors));
  }

  hasFailures(): boolean {
    return this.lastFailureCount > 0;
  }

  private async stopCurrent(): Promise<void> {
    const clients = [...this.clients.values()];
    const watchers = [...this.watchers.values()];
    this.clients.clear();
    this.watchers.clear();
    for (const watcher of watchers) watcher.dispose();
    await Promise.allSettled(clients.map((client) => client.stop()));
  }

  stopAll(): Promise<void> {
    return this.enqueue(() => this.stopCurrent());
  }
}

class DehermDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    configuration: vscode.DebugConfiguration
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    const resolved = { ...configuration };
    resolved.type ||= "deherm";
    resolved.request ||= "attach";
    resolved.name ||= "déherm: Attach to running game";
    resolved.project ||= folder?.uri.fsPath ?? "${workspaceFolder}";
    return resolved;
  }
}

class DehermDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly projects: ProjectRegistry) {}

  async createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    _executable: vscode.DebugAdapterExecutable | undefined
  ): Promise<vscode.DebugAdapterDescriptor> {
    await this.projects.refresh();
    const project = this.projects.select(session.configuration.project, session.workspaceFolder);
    const configuredPath = vscode.workspace.getConfiguration("deherm", vscode.Uri.file(project.projectRoot)).get<string>("cliPath") || undefined;
    const cliPath = await resolveDehermCli({
      projectRoot: project.projectRoot,
      workspaceRoot: project.workspaceRoot,
      configuredPath
    });
    const nodeExecutable = vscode.workspace.getConfiguration("deherm", vscode.Uri.file(project.projectRoot)).get<string>("nodePath") || undefined;
    const launch = debugAdapterLaunch({
      cliPath,
      projectRoot: project.projectRoot,
      nodeExecutable,
      inspectorSession: session.configuration.inspectorSession,
      replaceDebugger: session.configuration.replaceDebugger === true
    });
    return new vscode.DebugAdapterExecutable(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.env }
    });
  }
}

let activeClients: DehermClients | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("déherm");
  const projects = new ProjectRegistry();
  activeClients = new DehermClients(output, projects);
  context.subscriptions.push(
    output,
    vscode.debug.registerDebugConfigurationProvider("deherm", new DehermDebugConfigurationProvider()),
    vscode.debug.registerDebugAdapterDescriptorFactory("deherm", new DehermDebugAdapterFactory(projects)),
    vscode.commands.registerCommand("deherm.restartLanguageServer", async () => {
      await activeClients?.startAll(true);
      if (!activeClients?.hasFailures()) void vscode.window.showInformationMessage("déherm language server restarted");
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void activeClients?.startAll();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("deherm.cliPath") || event.affectsConfiguration("deherm.nodePath")) {
        void activeClients?.startAll();
      }
    })
  );
  await activeClients.startAll();
}

export async function deactivate(): Promise<void> {
  await activeClients?.stopAll();
  activeClients = undefined;
}
