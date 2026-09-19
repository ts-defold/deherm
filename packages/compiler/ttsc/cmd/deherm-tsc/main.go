// Command deherm-tsc is déherm's TypeScript transform compiler.
//
// The three transforms in ../../hash-literal are not optional: DefoldHash
// literal lowering, resource-name diagnostics, and the symbol-level Defold API
// reachability manifest are what make a déherm build a déherm build. They are
// written against the typescript-go checker, so they are Go, and something has
// to compile them.
//
// Until this command existed, that something was the user's machine. ttsc
// builds a plugin's Go source into a sidecar binary on demand, and it is
// explicit that this is the only route it offers:
//
//	ttsc accepts source only. It does not accept a prebuilt binary path: the
//	package-local Go compiler builds this source into the ttsc plugin cache on
//	demand.
//	  - node_modules/ttsc/lib/structures/ITtscPlugin.d.ts, field `source`
//
// That build is cached by a key that hashes the SHA-256 of the user's own `go`
// binary and its `go version` output (buildSourcePlugin.js,
// computeGoCompilerIdentity), so the cache cannot be seeded from CI either: a
// release cannot know which Go the user will have. The first déherm build on a
// cold cache therefore paid a full `go build` of the typescript-go compiler -
// observed at 40 seconds, and ttsc's own message warns it "can take several
// minutes on a cold Go cache".
//
// A user compiling a multi-megabyte Go program before their first line of
// TypeScript compiles contradicts the product contract directly: the user
// compiles nothing natively. So déherm ships this binary instead. It is the
// same program ttsc would have built - ttsc's linked-plugin host with our
// transform package statically linked through its init() registration - but it
// is built once, in CI, cross-compiled to every host from a single job, and
// pinned by digest like hermesc and shermes.
//
// It takes the arguments we define, not ttsc's. The flags below are the subset
// of ttsc's host flag allow-list déherm actually drives, named here so the
// contract is ours and a ttsc release that renames a flag is a compile-time
// concern rather than a silent behaviour change on a user's machine.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/samchon/ttsc/packages/ttsc/utility"

	// The blank import is the whole point of this file. The transform package
	// registers itself through driver.RegisterPlugin in its init(), exactly as
	// it does when ttsc links it as a contributor into its own host.
	_ "github.com/ts-defold/deherm/compiler/ttsc/hash-literal"
)

// Stamped by toolchains/go/build-deherm-tsc.sh through -ldflags -X. These are
// identity, not decoration: `deherm doctor` compares them against the pinned
// record so a binary built against a different ttsc than the one this checkout
// resolves is a named failure rather than a mysterious diagnostic.
var (
	dehermVersion = "0.0.0-dev"
	ttscVersion   = "unknown"
	hostKey       = "unknown"
)

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	if len(args) == 0 {
		usage(os.Stderr)
		return 2
	}
	switch args[0] {
	case "transform":
		// Whole-project transform. Writes the JSON envelope the bundler reads:
		// { typescript: { <relative output key>: <printed source> }, diagnostics,
		// graph, dependencies, hostInputs }.
		return utility.RunTransform(args[1:])
	case "check":
		// Diagnostics only. This is the pass that carries the resource-name
		// blockers, so it must be able to run without an emit.
		return utility.RunCheck(args[1:])
	case "build":
		return utility.RunBuild(args[1:])
	case "serve":
		// Resident host over stdin/stdout, for the watch loop.
		return utility.RunServe(os.Stdin, os.Stdout, args[1:])
	case "version", "--version", "-v":
		return printVersion()
	case "help", "--help", "-h":
		usage(os.Stdout)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "deherm-tsc: unknown command %q\n", args[0])
		usage(os.Stderr)
		return 2
	}
}

// printVersion emits machine-readable identity. `deherm doctor` reads it; a
// human reading it should be able to answer "is this the binary my package
// pinned" without running anything else.
func printVersion() int {
	payload := map[string]any{
		"schemaVersion": 1,
		"tool":          "deherm-tsc",
		"deherm":        dehermVersion,
		"ttsc":          ttscVersion,
		"host":          hostKey,
		"transforms":    []string{"defold-hash-literal", "resource-name", "defold-api-usage"},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		fmt.Fprintf(os.Stderr, "deherm-tsc: cannot encode version: %v\n", err)
		return 1
	}
	fmt.Fprintln(os.Stdout, string(encoded))
	return 0
}

func usage(out *os.File) {
	fmt.Fprint(out, `deherm-tsc - déherm's TypeScript transform compiler

Usage:
  deherm-tsc transform --tsconfig <path> [--cwd <dir>] [--plugins-json <json>]
  deherm-tsc check     --tsconfig <path> [--cwd <dir>] [--plugins-json <json>]
  deherm-tsc build     --tsconfig <path> --outdir <dir> [--cwd <dir>]
  deherm-tsc serve     --tsconfig <path> [--cwd <dir>]
  deherm-tsc version

Transforms linked into this binary:
  defold-hash-literal  DefoldHash literals lowered to their dmHash constants
  resource-name        resource-name diagnostics against the generated symbol table
  defold-api-usage     symbol-level Defold API reachability manifest
`)
}
