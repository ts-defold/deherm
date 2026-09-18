package hashliteral

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// The generated script surface every checked route is declared on. A member
// resolved anywhere else is a user's own symbol and is never checked.
const generatedScriptTypesSuffix = "/generated/script/types.ts"

const defaultSymbolTableRelativePath = ".deherm/generated/resource-symbols.json"

type declaration struct {
	Name  string `json:"name"`
	Line  int    `json:"line"`
	Field string `json:"field"`
}

type namespaceKind struct {
	Kind      string `json:"kind"`
	Extension string `json:"extension"`
}

type boundResource struct {
	Path string `json:"path"`
	Line int    `json:"line"`
}

type goComponent struct {
	Line      int                      `json:"line"`
	Type      string                   `json:"type"`
	Component *string                  `json:"component"`
	Resources map[string]boundResource `json:"resources"`
}

type gameObject struct {
	Components map[string]goComponent `json:"components"`
}

type collectionInstance struct {
	Line      int     `json:"line"`
	Prototype *string `json:"prototype"`
}

type collection struct {
	Instances map[string]collectionInstance `json:"instances"`
}

type componentAttachment struct {
	Proxy             string `json:"proxy"`
	AttachedResource  string `json:"attachedResource"`
	AttachedExtension string `json:"attachedExtension"`
	GameObject        string `json:"gameObject"`
	ComponentID       string `json:"componentId"`
	Collection        string `json:"collection"`
	Unresolved        string `json:"unresolved"`
}

type routeParameter struct {
	Parameter        string   `json:"parameter"`
	JSParameter      string   `json:"jsParameter"`
	Scope            string   `json:"scope"`
	Namespaces       []string `json:"namespaces"`
	AddressParameter *int     `json:"addressParameter"`
}

type symbolTable struct {
	SchemaVersion   int                                  `json:"schemaVersion"`
	ProjectRootFrom string                               `json:"projectRootFrom"`
	NamespaceKinds  map[string]namespaceKind             `json:"namespaceKinds"`
	Declarations    map[string]map[string][]declaration  `json:"declarations"`
	GameObjects     map[string]gameObject                `json:"gameObjects"`
	Collections     map[string]collection                `json:"collections"`
	Components      map[string]componentAttachment       `json:"components"`
	Routes          map[string]map[string]routeParameter `json:"routes"`

	root string
}

var symbolTableOnce struct {
	sync.Mutex
	loaded map[string]*symbolTable
}

// loadSymbolTable reads the generated project symbol table.
//
// Absence is not an error. A project that has not generated a table, or a
// compilation that runs outside one, simply keeps the behavior it had before
// resource names were checkable at all.
func loadSymbolTable(ctx driver.PluginContext) *symbolTable {
	base := driver.PluginConfigBaseDir(ctx.Cwd, ctx.Tsconfig)
	file := ""
	if configured, ok := ctx.Entry.Config["resourceSymbols"].(string); ok && strings.TrimSpace(configured) != "" {
		file = configured
		if !filepath.IsAbs(file) {
			file = filepath.Join(base, file)
		}
	} else {
		discovery := driver.DiscoverConfigFile(base, []string{defaultSymbolTableRelativePath})
		driver.ReportRejectedConfigCandidates(discovery.Probed, ctx.ReportHostInputHash, ctx.ReportHostInputRealpath)
		if len(discovery.Matches) != 1 {
			return nil
		}
		file = discovery.Matches[0]
	}
	file = filepath.Clean(file)

	symbolTableOnce.Lock()
	defer symbolTableOnce.Unlock()
	if symbolTableOnce.loaded == nil {
		symbolTableOnce.loaded = map[string]*symbolTable{}
	}
	if cached, ok := symbolTableOnce.loaded[file]; ok {
		return cached
	}
	symbolTableOnce.loaded[file] = nil
	content, err := os.ReadFile(file)
	if err != nil {
		ctx.ReportHostInputHash(file, nil)
		return nil
	}
	digest := sha256.Sum256(content)
	hash := hex.EncodeToString(digest[:])
	ctx.ReportHostInputHash(file, &hash)
	table := &symbolTable{}
	if err := json.Unmarshal(content, table); err != nil {
		return nil
	}
	root := table.ProjectRootFrom
	if root == "" {
		root = "."
	}
	table.root = filepath.Clean(filepath.Join(filepath.Dir(file), root))
	symbolTableOnce.loaded[file] = table
	return table
}

// projectRelative returns the project-relative spelling of a compiled file.
func (t *symbolTable) projectRelative(fileName string) (string, bool) {
	absolute, err := filepath.Abs(fileName)
	if err != nil {
		return "", false
	}
	relative, err := filepath.Rel(t.root, absolute)
	if err != nil {
		return "", false
	}
	slashed := filepath.ToSlash(relative)
	if slashed == ".." || strings.HasPrefix(slashed, "../") {
		return "", false
	}
	return slashed, true
}

func (t *symbolTable) declaredNames(resource, namespace string) ([]declaration, bool) {
	namespaces, ok := t.Declarations[resource]
	if !ok {
		return nil, false
	}
	names, ok := namespaces[namespace]
	return names, ok
}

func hasName(names []declaration, value string) bool {
	for _, entry := range names {
		if entry.Name == value {
			return true
		}
	}
	return false
}

func candidateList(names []declaration) string {
	values := make([]string, 0, len(names))
	for _, entry := range names {
		values = append(values, fmt.Sprintf("%q", entry.Name))
	}
	sort.Strings(values)
	if len(values) > 12 {
		return strings.Join(values[:12], ", ") + fmt.Sprintf(", and %d more", len(values)-12)
	}
	return strings.Join(values, ", ")
}

// resolvedMember identifies a call's callee on the generated script surface.
type resolvedMember struct {
	iface  string
	member string
}

func resolveGeneratedMember(program *driver.Program, expression *ast.Node) (resolvedMember, bool) {
	if expression == nil || program.Checker == nil {
		return resolvedMember{}, false
	}
	symbol := program.Checker.GetSymbolAtLocation(expression)
	if symbol == nil {
		return resolvedMember{}, false
	}
	for _, declaration := range symbol.Declarations {
		if declaration == nil || declaration.Kind != ast.KindPropertySignature {
			continue
		}
		source := ast.GetSourceFileOfNode(declaration)
		if source == nil || !strings.HasSuffix(filepath.ToSlash(source.FileName()), generatedScriptTypesSuffix) {
			continue
		}
		parent := declaration.Parent
		if parent == nil || parent.Kind != ast.KindInterfaceDeclaration {
			continue
		}
		name := declaration.Name()
		ifaceName := parent.Name()
		if name == nil || ifaceName == nil {
			continue
		}
		return resolvedMember{iface: ifaceName.Text(), member: name.Text()}, true
	}
	return resolvedMember{}, false
}

func stringArgument(call *ast.CallExpression, position int) (string, *ast.Node, bool) {
	if call.Arguments == nil || position < 0 || position >= len(call.Arguments.Nodes) {
		return "", nil, false
	}
	argument := call.Arguments.Nodes[position]
	if argument == nil || argument.Kind != ast.KindStringLiteral {
		return "", nil, false
	}
	return argument.AsStringLiteral().Text, argument, true
}

// addressTarget is the component or instance a Defold address literal names.
type addressTarget struct {
	instance  string
	fragment  string
	gameObject string
}

// resolveAddressLiteral checks a Defold address literal inside one component.
//
// Only the forms whose scope is decided by the project graph are answered.
// A socket-qualified address, a bare relative id, or anything the attachment
// does not pin down returns silence, because those names are resolved by the
// running engine against state the compiler cannot see.
func (t *symbolTable) resolveAddressLiteral(owner componentAttachment, literal string) (finding string, target addressTarget, checked bool) {
	if literal == "." || literal == "#" || literal == "" {
		return "", addressTarget{gameObject: owner.GameObject}, false
	}
	if strings.Contains(literal, ":") {
		return "", addressTarget{}, false
	}
	instance, fragment := literal, ""
	if index := strings.Index(literal, "#"); index >= 0 {
		instance, fragment = literal[:index], literal[index+1:]
	}
	gameObjectPath := ""
	switch {
	case instance == "":
		gameObjectPath = owner.GameObject
	case strings.HasPrefix(instance, "/"):
		if owner.Collection == "" {
			return "", addressTarget{}, false
		}
		owningCollection, ok := t.Collections[owner.Collection]
		if !ok {
			return "", addressTarget{}, false
		}
		id := strings.TrimPrefix(instance, "/")
		if strings.Contains(id, "/") {
			// A nested child path is resolved by the runtime hierarchy.
			return "", addressTarget{}, false
		}
		declared, ok := owningCollection.Instances[id]
		if !ok {
			names, _ := t.declaredNames(owner.Collection, "collection:instance")
			return fmt.Sprintf(
				"game object instance %q is not declared in collection:instance for %s. Declared instances: %s",
				id, owner.Collection, candidateList(names),
			), addressTarget{}, true
		}
		if declared.Prototype != nil {
			gameObjectPath = *declared.Prototype
		}
	default:
		// A bare relative id names a sibling or child at runtime.
		return "", addressTarget{}, false
	}
	if fragment == "" {
		return "", addressTarget{instance: instance, gameObject: gameObjectPath}, true
	}
	if gameObjectPath == "" {
		return "", addressTarget{}, false
	}
	object, ok := t.GameObjects[gameObjectPath]
	if !ok {
		return "", addressTarget{}, false
	}
	if _, ok := object.Components[fragment]; !ok {
		names, _ := t.declaredNames(gameObjectPath, "go:component")
		return fmt.Sprintf(
			"component %q is not declared in go:component for %s. Declared components: %s",
			fragment, gameObjectPath, candidateList(names),
		), addressTarget{}, true
	}
	return "", addressTarget{instance: instance, fragment: fragment, gameObject: gameObjectPath}, true
}

// checkAttachedResource resolves a literal against the resource the compiled
// component is attached to.
func (t *symbolTable) checkAttachedResource(owner componentAttachment, parameter routeParameter, literal string) string {
	for _, namespace := range parameter.Namespaces {
		kind, ok := t.NamespaceKinds[namespace]
		if !ok || kind.Extension != owner.AttachedExtension {
			continue
		}
		names, ok := t.declaredNames(owner.AttachedResource, namespace)
		if !ok {
			// The scene declares nothing in this namespace at all; a literal
			// cannot be judged against an empty, possibly unparsed, set.
			return ""
		}
		if hasName(names, literal) {
			return ""
		}
		return fmt.Sprintf(
			"resource name %q is not declared in %s for %s. Declared names: %s",
			literal, namespace, owner.AttachedResource, candidateList(names),
		)
	}
	return ""
}

// checkAddressedComponentResource resolves a literal against the resource bound
// to the component a sibling address parameter names.
func (t *symbolTable) checkAddressedComponentResource(
	owner componentAttachment,
	parameter routeParameter,
	call *ast.CallExpression,
	literal string,
) string {
	if parameter.AddressParameter == nil {
		return ""
	}
	address, _, ok := stringArgument(call, *parameter.AddressParameter)
	if !ok {
		return ""
	}
	_, target, checked := t.resolveAddressLiteral(owner, address)
	if !checked || target.fragment == "" || target.gameObject == "" {
		return ""
	}
	object, ok := t.GameObjects[target.gameObject]
	if !ok {
		return ""
	}
	component, ok := object.Components[target.fragment]
	if !ok {
		return ""
	}
	matches := make([]string, 0, 2)
	resources := make([]string, 0, 2)
	for _, namespace := range parameter.Namespaces {
		kind, ok := t.NamespaceKinds[namespace]
		if !ok {
			continue
		}
		bound, ok := component.Resources[kind.Extension]
		if !ok {
			continue
		}
		matches = append(matches, namespace)
		resources = append(resources, bound.Path)
	}
	if len(matches) != 1 {
		return ""
	}
	names, ok := t.declaredNames(resources[0], matches[0])
	if !ok || hasName(names, literal) {
		return ""
	}
	return fmt.Sprintf(
		"resource name %q is not declared in %s for %s, bound to component %q. Declared names: %s",
		literal, matches[0], resources[0], target.fragment, candidateList(names),
	)
}

func lineAndColumn(source *ast.SourceFile, position int) (int, int) {
	text := source.Text()
	if position > len(text) {
		position = len(text)
	}
	line, column := 1, 1
	for index := 0; index < position; index++ {
		if text[index] == '\n' {
			line++
			column = 1
			continue
		}
		column++
	}
	return line, column
}

// checkResourceNames resolves every literal name at a namespaced position in
// one source file.
//
// Silence is the default at every step: no symbol table, no attachment, no
// literal, or no determinable scope all leave the call alone. Only a literal
// whose namespace and scope are both known can produce a finding.
func checkResourceNames(program *driver.Program, table *symbolTable, source *ast.SourceFile) []string {
	if table == nil || source == nil {
		return nil
	}
	relative, ok := table.projectRelative(source.FileName())
	if !ok {
		return nil
	}
	owner, ok := table.Components[relative]
	if !ok || owner.Unresolved != "" {
		return nil
	}
	var findings []string
	var walk func(node *ast.Node) bool
	walk = func(node *ast.Node) bool {
		if node == nil {
			return false
		}
		if node.Kind == ast.KindCallExpression {
			call := node.AsCallExpression()
			if member, ok := resolveGeneratedMember(program, call.Expression); ok {
				parameters := table.Routes[member.iface+"."+member.member]
				positions := make([]string, 0, len(parameters))
				for position := range parameters {
					positions = append(positions, position)
				}
				sort.Strings(positions)
				for _, key := range positions {
					parameter := parameters[key]
					position := 0
					if _, err := fmt.Sscanf(key, "%d", &position); err != nil {
						continue
					}
					literal, argument, ok := stringArgument(call, position)
					if !ok {
						continue
					}
					finding := ""
					switch parameter.Scope {
					case "attached-resource":
						finding = table.checkAttachedResource(owner, parameter, literal)
					case "addressed-component-resource":
						finding = table.checkAddressedComponentResource(owner, parameter, call, literal)
					case "component-address":
						finding, _, _ = table.resolveAddressLiteral(owner, literal)
					}
					if finding == "" {
						continue
					}
					line, column := lineAndColumn(source, argument.Pos())
					findings = append(findings, fmt.Sprintf(
						"%s(%d,%d): Defold %s",
						relative, line, column, finding,
					))
				}
			}
		}
		node.ForEachChild(walk)
		return false
	}
	source.AsNode().ForEachChild(walk)
	return findings
}
