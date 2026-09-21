package hashliteral

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/checker"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

const defaultDmSdkSymbolIndexRelativePath = ".deherm/generated/dmsdk-call-symbol-index.json"

type dmSdkIndexDeclaration struct {
	DeclarationID   string               `json:"declarationId"`
	NumericID       uint32               `json:"numericId"`
	Materialization dmSdkMaterialization `json:"materialization"`
}

type dmSdkMaterialization struct {
	State        string             `json:"state"`
	Family       string             `json:"family,omitempty"`
	Wrapper      *string            `json:"wrapper,omitempty"`
	Route        *dmSdkAdapterRoute `json:"route,omitempty"`
	Requirements []string           `json:"requirements,omitempty"`
	Diagnostic   string             `json:"diagnostic,omitempty"`
}

type dmSdkAdapterRoute struct {
	Applicability string  `json:"applicability"`
	Kind          string  `json:"kind"`
	ID            *uint32 `json:"id"`
	Symbol        string  `json:"symbol,omitempty"`
	Header        string  `json:"header,omitempty"`
	PlanSha256    string  `json:"planSha256"`
}

type dmSdkIndexOverload struct {
	Symbol       string                  `json:"symbol"`
	Ambiguous    bool                    `json:"ambiguous"`
	Declarations []dmSdkIndexDeclaration `json:"declarations"`
}

type dmSdkIndexExact struct {
	NumericID       uint32               `json:"numericId"`
	Marker          string               `json:"marker"`
	Symbol          string               `json:"symbol"`
	Materialization dmSdkMaterialization `json:"materialization"`
}

type dmSdkSymbolIndex struct {
	SchemaVersion     int                           `json:"schemaVersion"`
	DefoldRevision    string                        `json:"defoldRevision"`
	CatalogSha256     string                        `json:"catalogSha256"`
	DeclarationSuffix string                        `json:"declarationSuffix"`
	RecipeCount       int                           `json:"recipeCount"`
	OverloadCount     int                           `json:"overloadCount"`
	AmbiguousCount    int                           `json:"ambiguousOverloadCount"`
	UniversalReady    int                           `json:"universalReadyCount"`
	GeneratedAdapters int                           `json:"generatedAdapterCount"`
	Specialization    int                           `json:"specializationRequiredCount"`
	Markers           map[string]dmSdkIndexOverload `json:"markers"`
	Declarations      map[string]dmSdkIndexExact    `json:"declarations"`
	IndexSha256       string                        `json:"indexSha256"`
	sourceSha256      string
}

type dmSdkCachedIndex struct {
	hash  string
	index *dmSdkSymbolIndex
}

var dmSdkIndexCache struct {
	sync.Mutex
	loaded map[string]dmSdkCachedIndex
}

func validDmSdkMaterialization(value dmSdkMaterialization) bool {
	switch value.State {
	case "universal-ready":
		return len(value.Requirements) == 0 && value.Diagnostic == ""
	case "generated-adapter":
		return value.Family != "" && len(value.Requirements) == 0 && value.Route != nil &&
			value.Route.Applicability == "callable" &&
			(value.Route.Kind == "named-wrapper" || value.Route.Kind == "family-dispatch") &&
			value.Route.Symbol != "" && value.Route.Header != "" && len(value.Route.PlanSha256) == 64
	case "specialization-required":
		return value.Diagnostic != ""
	default:
		return false
	}
}

func validDmSdkSymbolIndex(index *dmSdkSymbolIndex) bool {
	if index.SchemaVersion != 1 || len(index.Markers) != index.OverloadCount ||
		len(index.Declarations) != index.RecipeCount || len(index.CatalogSha256) != 64 ||
		index.DeclarationSuffix == "" || len(index.IndexSha256) != 64 {
		return false
	}
	seen := make(map[string]struct{}, index.RecipeCount)
	ambiguous := 0
	states := map[string]int{}
	for marker, overload := range index.Markers {
		if !strings.HasPrefix(marker, "__deherm_dmsdk_") || len(overload.Declarations) == 0 ||
			overload.Ambiguous != (len(overload.Declarations) > 1) {
			return false
		}
		if overload.Ambiguous {
			ambiguous++
		}
		for _, declaration := range overload.Declarations {
			exact, exists := index.Declarations[declaration.DeclarationID]
			if !exists || exact.NumericID != declaration.NumericID || exact.Marker != marker ||
				exact.Symbol != overload.Symbol || !validDmSdkMaterialization(exact.Materialization) ||
				!reflect.DeepEqual(exact.Materialization, declaration.Materialization) {
				return false
			}
			if _, duplicate := seen[declaration.DeclarationID]; duplicate {
				return false
			}
			seen[declaration.DeclarationID] = struct{}{}
			states[exact.Materialization.State]++
		}
	}
	return len(seen) == index.RecipeCount && ambiguous == index.AmbiguousCount &&
		states["universal-ready"] == index.UniversalReady &&
		states["generated-adapter"] == index.GeneratedAdapters &&
		states["specialization-required"] == index.Specialization &&
		index.UniversalReady+index.GeneratedAdapters+index.Specialization == index.RecipeCount
}

func validDmSdkIndexDigest(content []byte, claimed string) bool {
	body := map[string]any{}
	if err := json.Unmarshal(content, &body); err != nil {
		return false
	}
	value, ok := body["indexSha256"].(string)
	if !ok || value != claimed {
		return false
	}
	delete(body, "indexSha256")
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		return false
	}
	canonical := bytes.TrimSuffix(encoded.Bytes(), []byte{'\n'})
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]) == claimed
}

func loadDmSdkSymbolIndex(ctx driver.PluginContext) *dmSdkSymbolIndex {
	base := driver.PluginConfigBaseDir(ctx.Cwd, ctx.Tsconfig)
	file := configuredString(ctx.Entry.Config, "dmsdkSymbols")
	if file != "" {
		if !filepath.IsAbs(file) {
			file = filepath.Join(base, file)
		}
	} else {
		discovery := driver.DiscoverConfigFile(base, []string{defaultDmSdkSymbolIndexRelativePath})
		driver.ReportRejectedConfigCandidates(discovery.Probed, ctx.ReportHostInputHash, ctx.ReportHostInputRealpath)
		if len(discovery.Matches) != 1 {
			return nil
		}
		file = discovery.Matches[0]
	}
	file = filepath.Clean(file)

	content, err := os.ReadFile(file)
	if err != nil {
		ctx.ReportHostInputHash(file, nil)
		ctx.ReportHostInputRealpath(file, nil)
		return nil
	}
	digest := sha256.Sum256(content)
	hash := hex.EncodeToString(digest[:])
	ctx.ReportHostInputHash(file, &hash)
	reportSymbolTableRealpath(ctx, file)
	dmSdkIndexCache.Lock()
	if cached, ok := dmSdkIndexCache.loaded[file]; ok && cached.hash == hash {
		dmSdkIndexCache.Unlock()
		return cached.index
	}
	dmSdkIndexCache.Unlock()
	index := &dmSdkSymbolIndex{}
	if err := json.Unmarshal(content, index); err != nil {
		return nil
	}
	if !validDmSdkSymbolIndex(index) || !validDmSdkIndexDigest(content, index.IndexSha256) {
		return nil
	}
	index.sourceSha256 = hash
	dmSdkIndexCache.Lock()
	if dmSdkIndexCache.loaded == nil {
		dmSdkIndexCache.loaded = map[string]dmSdkCachedIndex{}
	}
	dmSdkIndexCache.loaded[file] = dmSdkCachedIndex{hash: hash, index: index}
	dmSdkIndexCache.Unlock()
	return index
}

type dmSdkUsage struct {
	DeclarationID   string               `json:"declarationId"`
	NumericID       uint32               `json:"numericId"`
	Symbol          string               `json:"symbol"`
	Materialization dmSdkMaterialization `json:"materialization"`
	Sites           []usageSite          `json:"sites"`
}

type dmSdkAmbiguousSite struct {
	usageSite
	Symbol         string   `json:"symbol"`
	DeclarationIDs []string `json:"declarationIds"`
}

type dmSdkUnresolvedSite struct {
	usageSite
	Marker string `json:"marker"`
	Reason string `json:"reason"`
}

type dmSdkSpecializationSite struct {
	usageSite
	DeclarationID string   `json:"declarationId"`
	Symbol        string   `json:"symbol"`
	Requirements  []string `json:"requirements"`
	Diagnostic    string   `json:"diagnostic"`
}

type dmSdkUsageManifest struct {
	SchemaVersion               int                       `json:"schemaVersion"`
	Generator                   string                    `json:"generator"`
	Profile                     string                    `json:"profile"`
	DefoldRevision              string                    `json:"defoldRevision"`
	CatalogSha256               string                    `json:"catalogSha256"`
	SymbolIndexSourceSha256     string                    `json:"symbolIndexSourceSha256"`
	SurfaceRecipeCount          int                       `json:"surfaceRecipeCount"`
	UsageCount                  int                       `json:"usageCount"`
	Usages                      []dmSdkUsage              `json:"usages"`
	AmbiguousSites              []dmSdkAmbiguousSite      `json:"ambiguousSites"`
	UnresolvedSites             []dmSdkUnresolvedSite     `json:"unresolvedSites"`
	SpecializationRequiredSites []dmSdkSpecializationSite `json:"specializationRequiredSites"`
}

func dmSdkMarkerFromDeclaration(declaration *ast.Node, suffix string) (string, bool) {
	if declaration == nil || declaration.Kind != ast.KindFunctionDeclaration {
		return "", false
	}
	source := ast.GetSourceFileOfNode(declaration)
	if source == nil || !strings.HasSuffix(filepath.ToSlash(source.FileName()), suffix) {
		return "", false
	}
	parameters := declaration.Parameters()
	if len(parameters) == 0 {
		return "", false
	}
	name := parameters[0].Name()
	if name == nil || !strings.HasPrefix(name.Text(), "__deherm_dmsdk_") {
		return "", false
	}
	return name.Text(), true
}

// dmSdkCallableMarker asks the checker whether an expression's callable type
// comes from the generated dmSDK runtime. Direct calls are resolved by their
// selected overload below. This companion catches Function.call/apply/bind and
// Reflect.apply, whose selected signature belongs to lib.d.ts rather than the
// generated declaration and would otherwise disappear from release reachability.
func dmSdkCallableMarker(program *driver.Program, expression *ast.Node, suffix string) (string, bool) {
	if expression == nil || program.Checker == nil {
		return "", false
	}
	typeOfExpression := program.Checker.GetTypeAtLocation(expression)
	if typeOfExpression == nil {
		return "", false
	}
	for _, signature := range program.Checker.GetSignaturesOfType(typeOfExpression, checker.SignatureKindCall) {
		if marker, ok := dmSdkMarkerFromDeclaration(signature.Declaration(), suffix); ok {
			return marker, true
		}
	}
	return "", false
}

func dmSdkIndirectCall(program *driver.Program, node *ast.Node, suffix string) (string, string, bool) {
	if node == nil || node.Kind != ast.KindCallExpression {
		return "", "", false
	}
	call := node.AsCallExpression()
	if call.Expression == nil || call.Expression.Kind != ast.KindPropertyAccessExpression {
		return "", "", false
	}
	access := call.Expression.AsPropertyAccessExpression()
	name := access.Name()
	if name == nil {
		return "", "", false
	}
	method := name.Text()
	if marker, ok := dmSdkCallableMarker(program, access.Expression, suffix); ok {
		return marker, fmt.Sprintf("indirect dmSDK invocation through .%s is not modeled", method), true
	}
	if method == "apply" && access.Expression != nil && access.Expression.Kind == ast.KindIdentifier &&
		access.Expression.AsIdentifier().Text == "Reflect" && call.Arguments != nil && len(call.Arguments.Nodes) > 0 {
		if marker, ok := dmSdkCallableMarker(program, call.Arguments.Nodes[0], suffix); ok {
			return marker, "indirect dmSDK invocation through Reflect.apply is not modeled", true
		}
	}
	return "", "", false
}

func collectDmSdkUsage(program *driver.Program, ctx driver.PluginContext) ([]string, error) {
	output := configuredString(ctx.Entry.Config, "dmsdkUsage")
	if output == "" {
		return nil, nil
	}
	index := loadDmSdkSymbolIndex(ctx)
	if index == nil {
		return nil, fmt.Errorf(
			"deherm: dmsdkUsage is configured but no usable dmSDK symbol index was found; "+
				"set the plugin's \"dmsdkSymbols\" path or generate %s",
			defaultDmSdkSymbolIndexRelativePath)
	}
	base := driver.PluginConfigBaseDir(ctx.Cwd, ctx.Tsconfig)
	if !filepath.IsAbs(output) {
		output = filepath.Join(base, output)
	}
	profile := configuredString(ctx.Entry.Config, "profile")
	if profile == "" {
		profile = "development"
	}
	sitesByDeclaration := map[string]map[usageSite]struct{}{}
	declarationByID := map[string]dmSdkIndexExact{}
	symbolByID := map[string]string{}
	ambiguous := make([]dmSdkAmbiguousSite, 0)
	unresolved := make([]dmSdkUnresolvedSite, 0)
	specialization := make([]dmSdkSpecializationSite, 0)
	record := func(declarationID string, declaration dmSdkIndexExact, symbol string, site usageSite) {
		set := sitesByDeclaration[declarationID]
		if set == nil {
			set = map[usageSite]struct{}{}
			sitesByDeclaration[declarationID] = set
		}
		set[site] = struct{}{}
		declarationByID[declarationID] = declaration
		symbolByID[declarationID] = symbol
	}
	selectDeclaration := func(declarationID string, declaration dmSdkIndexExact, symbol string, site usageSite) {
		if declaration.Materialization.State == "specialization-required" {
			specialization = append(specialization, dmSdkSpecializationSite{
				usageSite: site, DeclarationID: declarationID, Symbol: symbol,
				Requirements: declaration.Materialization.Requirements,
				Diagnostic:   declaration.Materialization.Diagnostic,
			})
			return
		}
		record(declarationID, declaration, symbol, site)
	}
	for _, source := range program.TSProgram.SourceFiles() {
		if source == nil || source.IsDeclarationFile {
			continue
		}
		file := (&usageCollector{root: filepath.Clean(base)}).fileKey(source.FileName())
		var walk func(node *ast.Node) bool
		walk = func(node *ast.Node) bool {
			if node == nil {
				return false
			}
			if node.Kind == ast.KindCallExpression && program.Checker != nil {
				if marker, reason, indirect := dmSdkIndirectCall(program, node, index.DeclarationSuffix); indirect {
					line, column := lineAndColumn(source, node.Pos())
					unresolved = append(unresolved, dmSdkUnresolvedSite{
						usageSite: usageSite{File: file, Line: line, Column: column}, Marker: marker, Reason: reason,
					})
				}
				signature := program.Checker.GetResolvedSignature(node)
				if signature != nil {
					if marker, ok := dmSdkMarkerFromDeclaration(signature.Declaration(), index.DeclarationSuffix); ok {
						line, column := lineAndColumn(source, node.Pos())
						site := usageSite{File: file, Line: line, Column: column}
						if marker == "__deherm_dmsdk_exact" {
							call := node.AsCallExpression()
							if call.Arguments != nil && len(call.Arguments.Nodes) > 0 &&
								call.Arguments.Nodes[0].Kind == ast.KindStringLiteral {
								declarationID := call.Arguments.Nodes[0].AsStringLiteral().Text
								if exact, exists := index.Declarations[declarationID]; exists {
									selectDeclaration(declarationID, exact, exact.Symbol, site)
								} else {
									unresolved = append(unresolved, dmSdkUnresolvedSite{
										usageSite: site, Marker: marker, Reason: "literal declaration ID is absent from the generated dmSDK index",
									})
								}
							} else {
								unresolved = append(unresolved, dmSdkUnresolvedSite{
									usageSite: site, Marker: marker, Reason: "exact dmSDK declaration ID must be a string literal",
								})
							}
						} else if overload, found := index.Markers[marker]; found {
							if len(overload.Declarations) == 1 {
								declaration := overload.Declarations[0]
								selectDeclaration(declaration.DeclarationID, dmSdkIndexExact{
									NumericID: declaration.NumericID, Marker: marker, Symbol: overload.Symbol,
									Materialization: declaration.Materialization,
								}, overload.Symbol, site)
							} else {
								ids := make([]string, 0, len(overload.Declarations))
								for _, declaration := range overload.Declarations {
									ids = append(ids, declaration.DeclarationID)
								}
								sort.Strings(ids)
								ambiguous = append(ambiguous, dmSdkAmbiguousSite{
									usageSite: site, Symbol: overload.Symbol, DeclarationIDs: ids,
								})
							}
						} else {
							unresolved = append(unresolved, dmSdkUnresolvedSite{
								usageSite: site, Marker: marker,
								Reason: "resolved dmSDK overload marker is absent from the generated index",
							})
						}
					}
				}
			}
			node.ForEachChild(walk)
			return false
		}
		source.AsNode().ForEachChild(walk)
	}
	usages := make([]dmSdkUsage, 0, len(sitesByDeclaration))
	for declarationID, set := range sitesByDeclaration {
		sites := make([]usageSite, 0, len(set))
		for site := range set {
			sites = append(sites, site)
		}
		sort.Slice(sites, func(i, j int) bool { return compareSites(sites[i], sites[j]) })
		declaration := declarationByID[declarationID]
		usages = append(usages, dmSdkUsage{
			DeclarationID:   declarationID,
			NumericID:       declaration.NumericID,
			Symbol:          symbolByID[declarationID],
			Materialization: declaration.Materialization,
			Sites:           sites,
		})
	}
	sort.Slice(usages, func(i, j int) bool { return usages[i].DeclarationID < usages[j].DeclarationID })
	sort.Slice(ambiguous, func(i, j int) bool {
		return compareSites(ambiguous[i].usageSite, ambiguous[j].usageSite)
	})
	sort.Slice(unresolved, func(i, j int) bool {
		return compareSites(unresolved[i].usageSite, unresolved[j].usageSite)
	})
	sort.Slice(specialization, func(i, j int) bool {
		return compareSites(specialization[i].usageSite, specialization[j].usageSite)
	})
	manifest := dmSdkUsageManifest{
		SchemaVersion:               1,
		Generator:                   "@ts-defold/deherm ttsc/dmsdk-usage/v1",
		Profile:                     profile,
		DefoldRevision:              index.DefoldRevision,
		CatalogSha256:               index.CatalogSha256,
		SymbolIndexSourceSha256:     index.sourceSha256,
		SurfaceRecipeCount:          index.RecipeCount,
		UsageCount:                  len(usages),
		Usages:                      usages,
		AmbiguousSites:              ambiguous,
		UnresolvedSites:             unresolved,
		SpecializationRequiredSites: specialization,
	}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := writeIfChanged(filepath.Clean(output), append(encoded, '\n')); err != nil {
		return nil, fmt.Errorf("deherm: cannot write the dmSDK usage manifest: %w", err)
	}
	if profile != "release" || (len(ambiguous) == 0 && len(unresolved) == 0 && len(specialization) == 0) {
		return nil, nil
	}
	findings := make([]string, 0, len(ambiguous))
	for _, site := range ambiguous {
		findings = append(findings, fmt.Sprintf(
			"%s(%d,%d): dmSDK call %s collapses %d native declarations to the same TypeScript signature; "+
				"use an exact declaration selector before release materialization (%s)",
			site.File, site.Line, site.Column, site.Symbol, len(site.DeclarationIDs),
			strings.Join(site.DeclarationIDs, ", "),
		))
	}
	for _, site := range unresolved {
		findings = append(findings, fmt.Sprintf(
			"%s(%d,%d): %s; release materialization cannot omit an unresolved dmSDK call",
			site.File, site.Line, site.Column, site.Reason,
		))
	}
	for _, site := range specialization {
		findings = append(findings, fmt.Sprintf(
			"%s(%d,%d): dmSDK call %s requires generated usage specialization before release materialization: %s",
			site.File, site.Line, site.Column, site.Symbol, site.Diagnostic,
		))
	}
	return findings, nil
}
