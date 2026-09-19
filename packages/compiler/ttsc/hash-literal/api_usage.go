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

// Symbol-level Defold API reachability, resolved by the checker.
//
// The bundler's module graph cannot answer this question. `gui.getNode` and
// `gui.newPieNode` are members of one generated module, so importing either
// retains both, and a release build that trusts module granularity keeps the
// whole Defold surface. The checker already resolves a call site to the exact
// interface member it names - that is how `DefoldHash` literals and resource
// names are lowered - and that member maps one-to-one onto a canonical route
// ID. This pass records those IDs.
//
// It never prunes anything by itself. It emits a manifest; the release
// projection decides what to do with it, and development deliberately ignores
// it for linkage and uses it only to report.

const defaultRouteSymbolIndexRelativePath = ".deherm/generated/script-route-symbol-index.json"

type routeSymbol struct {
	ID         string            `json:"id"`
	StableID   uint32            `json:"stableId"`
	Namespace  string            `json:"namespace"`
	Selections map[string]string `json:"selections"`
}

type routeSymbolIndex struct {
	SchemaVersion     int                    `json:"schemaVersion"`
	DefoldRevision    string                 `json:"defoldRevision"`
	LoweringPlanSha   string                 `json:"loweringPlanSha256"`
	DeclarationSuffix string                 `json:"declarationSuffix"`
	RouteCount        int                    `json:"routeCount"`
	Namespaces        map[string]string      `json:"namespaces"`
	Members           map[string]routeSymbol `json:"members"`
	IndexSha256       string                 `json:"indexSha256"`

	// memberNames is the set of final path segments, used to skip checker
	// resolution for the overwhelming majority of property accesses that
	// cannot possibly name a Defold route.
	memberNames map[string]struct{}
}

var routeIndexOnce struct {
	sync.Mutex
	loaded map[string]*routeSymbolIndex
}

// loadRouteSymbolIndex reads the generated member-path to route-identity index.
//
// Absence is not an error: a compilation without the index simply produces no
// usage manifest, exactly as every compilation did before reachability was
// computable at all.
func loadRouteSymbolIndex(ctx driver.PluginContext) *routeSymbolIndex {
	base := driver.PluginConfigBaseDir(ctx.Cwd, ctx.Tsconfig)
	file := ""
	if configured, ok := ctx.Entry.Config["routeSymbols"].(string); ok && strings.TrimSpace(configured) != "" {
		file = configured
		if !filepath.IsAbs(file) {
			file = filepath.Join(base, file)
		}
	} else {
		discovery := driver.DiscoverConfigFile(base, []string{defaultRouteSymbolIndexRelativePath})
		driver.ReportRejectedConfigCandidates(discovery.Probed, ctx.ReportHostInputHash, ctx.ReportHostInputRealpath)
		if len(discovery.Matches) != 1 {
			return nil
		}
		file = discovery.Matches[0]
	}
	file = filepath.Clean(file)

	routeIndexOnce.Lock()
	defer routeIndexOnce.Unlock()
	if routeIndexOnce.loaded == nil {
		routeIndexOnce.loaded = map[string]*routeSymbolIndex{}
	}
	if cached, ok := routeIndexOnce.loaded[file]; ok {
		return cached
	}
	routeIndexOnce.loaded[file] = nil
	content, err := os.ReadFile(file)
	if err != nil {
		// A declared host input needs both proofs; reporting only one leaves
		// the transform generation refused on every delivery.
		ctx.ReportHostInputHash(file, nil)
		ctx.ReportHostInputRealpath(file, nil)
		return nil
	}
	digest := sha256.Sum256(content)
	hash := hex.EncodeToString(digest[:])
	ctx.ReportHostInputHash(file, &hash)
	reportSymbolTableRealpath(ctx, file)
	index := &routeSymbolIndex{}
	if err := json.Unmarshal(content, index); err != nil {
		return nil
	}
	if index.SchemaVersion != 1 || len(index.Members) == 0 {
		return nil
	}
	if index.DeclarationSuffix == "" {
		index.DeclarationSuffix = generatedScriptTypesSuffix
	}
	index.memberNames = make(map[string]struct{}, len(index.Members))
	for member := range index.Members {
		segments := strings.Split(member, ".")
		index.memberNames[segments[len(segments)-1]] = struct{}{}
	}
	routeIndexOnce.loaded[file] = index
	return index
}

type usageSite struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
}

type dynamicSite struct {
	usageSite
	Reason string `json:"reason"`
}

type usageCollector struct {
	index    *routeSymbolIndex
	root     string
	routes   map[string]map[usageSite]struct{}
	files    map[string]map[string]struct{}
	dynamic  map[dynamicSite]struct{}
	declared bool
	profile  string
}

func newUsageCollector(index *routeSymbolIndex, root string, profile string, declared bool) *usageCollector {
	return &usageCollector{
		index:    index,
		root:     root,
		routes:   map[string]map[usageSite]struct{}{},
		files:    map[string]map[string]struct{}{},
		dynamic:  map[dynamicSite]struct{}{},
		declared: declared,
		profile:  profile,
	}
}

// fileKey spells a compiled file the way the manifest's consumers do: relative
// to the project root when it lies inside it, and by its cleaned absolute path
// otherwise. A stable spelling matters because the bundler joins its own
// retained-input set to these keys.
func (c *usageCollector) fileKey(fileName string) string {
	absolute, err := filepath.Abs(fileName)
	if err != nil {
		return filepath.ToSlash(filepath.Clean(fileName))
	}
	if c.root != "" {
		if relative, err := filepath.Rel(c.root, absolute); err == nil {
			slashed := filepath.ToSlash(relative)
			if slashed != ".." && !strings.HasPrefix(slashed, "../") {
				return slashed
			}
		}
	}
	return filepath.ToSlash(filepath.Clean(absolute))
}

func (c *usageCollector) record(member string, file string, line int, column int) {
	route, ok := c.index.Members[member]
	if !ok {
		return
	}
	site := usageSite{File: file, Line: line, Column: column}
	sites, ok := c.routes[route.ID]
	if !ok {
		sites = map[usageSite]struct{}{}
		c.routes[route.ID] = sites
	}
	sites[site] = struct{}{}
	routes, ok := c.files[file]
	if !ok {
		routes = map[string]struct{}{}
		c.files[file] = routes
	}
	routes[route.ID] = struct{}{}
}

func (c *usageCollector) recordDynamic(file string, line int, column int, reason string) {
	c.dynamic[dynamicSite{usageSite: usageSite{File: file, Line: line, Column: column}, Reason: reason}] = struct{}{}
}

// declaredMemberPath rebuilds the member path a resolved declaration spells on
// the generated script surface.
//
// The generated surface nests a Lua submodule as an anonymous type literal
// inside its declaring interface, so `b2d.body.applyForce` is a property
// signature whose parents are a type literal, the `body` property signature,
// and finally the `B2dApi` interface. Walking that chain is what turns a
// resolved symbol into a name the route index can answer.
func declaredMemberPath(declaration *ast.Node, declarationSuffix string) (string, bool) {
	if declaration == nil || declaration.Kind != ast.KindPropertySignature {
		return "", false
	}
	source := ast.GetSourceFileOfNode(declaration)
	if source == nil || !strings.HasSuffix(filepath.ToSlash(source.FileName()), declarationSuffix) {
		return "", false
	}
	var segments []string
	node := declaration
	for node != nil {
		if node.Kind == ast.KindPropertySignature {
			name := node.Name()
			if name == nil {
				return "", false
			}
			segments = append(segments, name.Text())
			node = node.Parent
			continue
		}
		if node.Kind == ast.KindTypeLiteral {
			node = node.Parent
			continue
		}
		if node.Kind == ast.KindInterfaceDeclaration {
			name := node.Name()
			if name == nil {
				return "", false
			}
			segments = append(segments, name.Text())
			break
		}
		return "", false
	}
	if node == nil || len(segments) < 2 {
		return "", false
	}
	for left, right := 0, len(segments)-1; left < right; left, right = left+1, right-1 {
		segments[left], segments[right] = segments[right], segments[left]
	}
	return strings.Join(segments, "."), true
}

// resolveRouteMember answers the member path a reference names, or silence.
func resolveRouteMember(program *driver.Program, index *routeSymbolIndex, reference *ast.Node) (string, bool) {
	if reference == nil || program.Checker == nil {
		return "", false
	}
	symbol := program.Checker.GetSymbolAtLocation(reference)
	if symbol == nil {
		return "", false
	}
	for _, declaration := range symbol.Declarations {
		if member, ok := declaredMemberPath(declaration, index.DeclarationSuffix); ok {
			return member, true
		}
	}
	return "", false
}

// indexesGeneratedSurface reports whether a computed element access reads the
// generated Defold surface.
//
// The object's own symbol is not enough: a project imports `gui` as an ordinary
// const from its generated SDK, so the evidence has to come from the type. A
// type with at least one property declared in the generated script declarations
// is the generated surface, however the value reached this position.
func indexesGeneratedSurface(program *driver.Program, index *routeSymbolIndex, expression *ast.Node) bool {
	if expression == nil || program.Checker == nil {
		return false
	}
	objectType := program.Checker.GetTypeAtLocation(expression)
	if objectType == nil {
		return false
	}
	objectType = program.Checker.GetNonNullableType(objectType)
	if objectType == nil {
		return false
	}
	for _, property := range program.Checker.GetPropertiesOfType(objectType) {
		for _, declaration := range property.Declarations {
			if declaration == nil || declaration.Kind != ast.KindPropertySignature {
				continue
			}
			source := ast.GetSourceFileOfNode(declaration)
			if source != nil && strings.HasSuffix(filepath.ToSlash(source.FileName()), index.DeclarationSuffix) {
				return true
			}
		}
	}
	return false
}

func (c *usageCollector) visitSourceFile(program *driver.Program, source *ast.SourceFile) {
	file := c.fileKey(source.FileName())
	var walk func(node *ast.Node) bool
	walk = func(node *ast.Node) bool {
		if node == nil {
			return false
		}
		switch node.Kind {
		case ast.KindPropertyAccessExpression:
			access := node.AsPropertyAccessExpression()
			name := access.Name()
			if name != nil {
				if _, plausible := c.index.memberNames[name.Text()]; plausible {
					if member, ok := resolveRouteMember(program, c.index, node); ok {
						line, column := lineAndColumn(source, name.Pos())
						c.record(member, file, line, column)
					}
				}
			}
		case ast.KindElementAccessExpression:
			access := node.AsElementAccessExpression()
			argument := access.ArgumentExpression
			if argument != nil && argument.Kind == ast.KindStringLiteral {
				text := argument.AsStringLiteral().Text
				if _, plausible := c.index.memberNames[text]; plausible {
					if member, ok := resolveRouteMember(program, c.index, node); ok {
						line, column := lineAndColumn(source, argument.Pos())
						c.record(member, file, line, column)
					}
				}
			} else if indexesGeneratedSurface(program, c.index, access.Expression) {
				line, column := lineAndColumn(source, node.Pos())
				c.recordDynamic(file, line, column,
					"computed member access on the generated Defold script surface")
			}
		}
		node.ForEachChild(walk)
		return false
	}
	source.AsNode().ForEachChild(walk)
}

type manifestRoute struct {
	ID        string      `json:"id"`
	StableID  uint32      `json:"stableId"`
	Member    string      `json:"member"`
	Namespace string      `json:"namespace"`
	Sites     []usageSite `json:"sites"`
}

type usageManifest struct {
	SchemaVersion         int                 `json:"schemaVersion"`
	Generator             string              `json:"generator"`
	Profile               string              `json:"profile"`
	DefoldRevision        string              `json:"defoldRevision"`
	RouteIndexSha256      string              `json:"routeIndexSha256"`
	LoweringPlanSha256    string              `json:"loweringPlanSha256"`
	SurfaceRouteCount     int                 `json:"surfaceRouteCount"`
	DeclaredDynamicAccess bool                `json:"declaredDynamicAccess"`
	DynamicAccess         bool                `json:"dynamicAccess"`
	DynamicSites          []dynamicSite       `json:"dynamicSites"`
	RouteCount            int                 `json:"routeCount"`
	Routes                []manifestRoute     `json:"routes"`
	Files                 map[string][]string `json:"files"`
}

func compareSites(left usageSite, right usageSite) bool {
	if left.File != right.File {
		return left.File < right.File
	}
	if left.Line != right.Line {
		return left.Line < right.Line
	}
	return left.Column < right.Column
}

func (c *usageCollector) manifest() usageManifest {
	routes := make([]manifestRoute, 0, len(c.routes))
	byID := map[string]routeSymbol{}
	memberByID := map[string]string{}
	for member, route := range c.index.Members {
		byID[route.ID] = route
		// Member paths are one-to-one with routes, so this is unambiguous.
		memberByID[route.ID] = member
	}
	for id, siteSet := range c.routes {
		sites := make([]usageSite, 0, len(siteSet))
		for site := range siteSet {
			sites = append(sites, site)
		}
		sort.Slice(sites, func(i, j int) bool { return compareSites(sites[i], sites[j]) })
		route := byID[id]
		routes = append(routes, manifestRoute{
			ID:        id,
			StableID:  route.StableID,
			Member:    memberByID[id],
			Namespace: route.Namespace,
			Sites:     sites,
		})
	}
	sort.Slice(routes, func(i, j int) bool { return routes[i].ID < routes[j].ID })
	dynamic := make([]dynamicSite, 0, len(c.dynamic))
	for site := range c.dynamic {
		dynamic = append(dynamic, site)
	}
	sort.Slice(dynamic, func(i, j int) bool {
		if dynamic[i].usageSite != dynamic[j].usageSite {
			return compareSites(dynamic[i].usageSite, dynamic[j].usageSite)
		}
		return dynamic[i].Reason < dynamic[j].Reason
	})
	files := map[string][]string{}
	for file, routeSet := range c.files {
		ids := make([]string, 0, len(routeSet))
		for id := range routeSet {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		files[file] = ids
	}
	return usageManifest{
		SchemaVersion:         1,
		Generator:             "@ts-defold/deherm ttsc/defold-api-usage/v1",
		Profile:               c.profile,
		DefoldRevision:        c.index.DefoldRevision,
		RouteIndexSha256:      c.index.IndexSha256,
		LoweringPlanSha256:    c.index.LoweringPlanSha,
		SurfaceRouteCount:     c.index.RouteCount,
		DeclaredDynamicAccess: c.declared,
		DynamicAccess:         len(c.dynamic) > 0,
		DynamicSites:          dynamic,
		RouteCount:            len(routes),
		Routes:                routes,
		Files:                 files,
	}
}

// manifestWrites serializes publication. Two programs in one process can reach
// this concurrently and would otherwise share the staging path.
var manifestWrites sync.Mutex

// writeIfChanged publishes the manifest without disturbing consumers that watch
// it. An identical byte sequence leaves the file - and its mtime - alone.
func writeIfChanged(file string, contents []byte) error {
	manifestWrites.Lock()
	defer manifestWrites.Unlock()
	if existing, err := os.ReadFile(file); err == nil && string(existing) == string(contents) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.staging-%d", file, os.Getpid())
	if err := os.WriteFile(temporary, contents, 0o644); err != nil {
		return err
	}
	if err := os.Rename(temporary, file); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func configuredBool(config map[string]any, key string) bool {
	value, ok := config[key].(bool)
	return ok && value
}

func configuredString(config map[string]any, key string) string {
	value, ok := config[key].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

// collectDefoldApiUsage resolves and publishes the reachable Defold route set.
//
// The returned findings are compile diagnostics. Undeclared dynamic access is
// one only under the release profile: development deliberately links the
// complete surface, so an undeclared computed access there costs nothing and is
// reported through the manifest instead of interrupting the edit loop.
func collectDefoldApiUsage(program *driver.Program, ctx driver.PluginContext) ([]string, error) {
	output := configuredString(ctx.Entry.Config, "apiUsage")
	if output == "" {
		return nil, nil
	}
	index := loadRouteSymbolIndex(ctx)
	if index == nil {
		return nil, fmt.Errorf(
			"deherm: apiUsage is configured but no usable script route symbol index was found; "+
				"set the plugin's \"routeSymbols\" path or generate %s",
			defaultRouteSymbolIndexRelativePath)
	}
	base := driver.PluginConfigBaseDir(ctx.Cwd, ctx.Tsconfig)
	if !filepath.IsAbs(output) {
		output = filepath.Join(base, output)
	}
	profile := configuredString(ctx.Entry.Config, "profile")
	if profile == "" {
		profile = "development"
	}
	collector := newUsageCollector(index, filepath.Clean(base), profile,
		configuredBool(ctx.Entry.Config, "dynamicApiAccess"))
	for _, sourceFile := range program.TSProgram.SourceFiles() {
		if sourceFile == nil || sourceFile.IsDeclarationFile {
			continue
		}
		collector.visitSourceFile(program, sourceFile)
	}
	manifest := collector.manifest()
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := writeIfChanged(filepath.Clean(output), append(encoded, '\n')); err != nil {
		return nil, fmt.Errorf("deherm: cannot write the Defold API usage manifest: %w", err)
	}
	if !manifest.DynamicAccess || manifest.DeclaredDynamicAccess {
		return nil, nil
	}
	findings := make([]string, 0, len(manifest.DynamicSites))
	for _, site := range manifest.DynamicSites {
		findings = append(findings, fmt.Sprintf(
			"%s(%d,%d): Defold API reachability cannot be resolved here: %s. "+
				"A release build would have to retain all %d routes. Declare it with "+
				"\"dynamicApiAccess\": true on the deherm ttsc plugin entry to opt into the complete surface.",
			site.File, site.Line, site.Column, site.Reason, index.RouteCount,
		))
	}
	if profile == "release" {
		return findings, nil
	}
	return nil, nil
}
