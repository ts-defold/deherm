package hashliteral

import (
	"encoding/binary"
	"fmt"
	"strings"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

const (
	murmurMultiplier uint64 = 0xc6a4a7935bd1e995
	murmurShift             = 47
)

type plugin struct{}

func init() {
	driver.RegisterPlugin(plugin{})
}

func mix(hash uint64, value uint64) uint64 {
	value *= murmurMultiplier
	value ^= value >> murmurShift
	value *= murmurMultiplier
	hash *= murmurMultiplier
	return hash ^ value
}

// hashString64 is byte-for-byte dmHashBufferNoReverse64. Go strings carry the
// same UTF-8 bytes TypeScript source literals use after parsing.
func hashString64(value string) uint64 {
	data := []byte(value)
	hash := uint64(0)
	offset := 0
	for len(data)-offset >= 8 {
		hash = mix(hash, binary.LittleEndian.Uint64(data[offset:offset+8]))
		offset += 8
	}
	tail := uint64(0)
	for index, value := range data[offset:] {
		tail |= uint64(value) << (8 * index)
	}
	hash = mix(hash, tail)
	hash = mix(hash, uint64(len(data)))
	hash ^= hash >> murmurShift
	hash *= murmurMultiplier
	hash ^= hash >> murmurShift
	return hash
}

func importedHashLiteral(program *driver.Program, expression *ast.Node) bool {
	if expression == nil || expression.Kind != ast.KindIdentifier || program.Checker == nil {
		return false
	}
	symbol := program.Checker.GetSymbolAtLocation(expression)
	if symbol == nil {
		return false
	}
	for _, declaration := range symbol.Declarations {
		if declaration == nil || declaration.Kind != ast.KindImportSpecifier {
			continue
		}
		specifier := declaration.AsImportSpecifier()
		importedName := specifier.Name().Text()
		if specifier.PropertyName != nil && specifier.PropertyName.Kind == ast.KindIdentifier {
			importedName = specifier.PropertyName.AsIdentifier().Text
		}
		if importedName != "hashLiteral" {
			continue
		}
		for parent := declaration.Parent; parent != nil; parent = parent.Parent {
			if parent.Kind != ast.KindImportDeclaration {
				continue
			}
			module := parent.AsImportDeclaration().ModuleSpecifier
			if module == nil || module.Kind != ast.KindStringLiteral {
				return false
			}
			specifier := module.AsStringLiteral().Text
			return specifier == "@ts-defold/deherm" || specifier == "@deherm/project"
		}
	}
	return false
}

func hashLiteralCall(program *driver.Program, node *ast.Node) (uint64, bool, error) {
	if node == nil || node.Kind != ast.KindCallExpression {
		return 0, false, nil
	}
	call := node.AsCallExpression()
	if !importedHashLiteral(program, call.Expression) {
		return 0, false, nil
	}
	if call.Arguments == nil || len(call.Arguments.Nodes) != 1 {
		return 0, false, fmt.Errorf("hashLiteral requires exactly one string literal argument")
	}
	argument := call.Arguments.Nodes[0]
	if argument == nil || argument.Kind != ast.KindStringLiteral {
		return 0, false, fmt.Errorf("hashLiteral requires a compile-time string literal; dynamic strings are not allowed")
	}
	literal := argument.AsStringLiteral().Text
	if len(literal) < 2 || !strings.HasPrefix(literal, "#") {
		return 0, false, fmt.Errorf("hashLiteral requires a #name sigil with a non-empty name")
	}
	return hashString64(strings.TrimPrefix(literal, "#")), true, nil
}

// contextualHashLiteral recognizes the nominal DefoldHash contract through
// its generated brand instead of a type spelling. Aliases therefore work, and
// ambiguous string | DefoldHash parameters fail closed because the union does
// not expose the brand on every non-nullish constituent.
func contextualHashLiteral(program *driver.Program, node *ast.Node) (uint64, bool, error) {
	if node == nil || node.Kind != ast.KindStringLiteral || program.Checker == nil {
		return 0, false, nil
	}
	contextual := program.Checker.GetContextualType(node, 0)
	if contextual == nil {
		return 0, false, nil
	}
	contextual = program.Checker.GetNonNullableType(contextual)
	if program.Checker.GetPropertyOfType(contextual, "__dehermHashV1") == nil {
		return 0, false, nil
	}
	literal := node.AsStringLiteral().Text
	if len(literal) < 2 || !strings.HasPrefix(literal, "#") {
		return 0, false, fmt.Errorf("a string used as DefoldHash must use the #name sigil with a non-empty name")
	}
	return hashString64(strings.TrimPrefix(literal, "#")), true, nil
}

func (plugin) ApplyProgram(program *driver.Program, _ driver.PluginContext) error {
	if program == nil || program.TSProgram == nil {
		return fmt.Errorf("deherm hash literal plugin received a nil TypeScript program")
	}
	factory := ast.NewNodeFactory(ast.NodeFactoryHooks{})
	for _, sourceFile := range program.TSProgram.SourceFiles() {
		if sourceFile == nil || sourceFile.IsDeclarationFile {
			continue
		}
		var transformError error
		var visitor *ast.NodeVisitor
		visitor = ast.NewNodeVisitor(func(node *ast.Node) *ast.Node {
			if transformError != nil {
				return node
			}
			if value, ok, err := hashLiteralCall(program, node); err != nil {
				transformError = fmt.Errorf("%s: %w", sourceFile.FileName(), err)
				return node
			} else if ok {
				return factory.NewBigIntLiteral(
					"0x"+strings.ToLower(hex16(value))+"n",
					ast.TokenFlagsNone,
				)
			}
			if value, ok, err := contextualHashLiteral(program, node); err != nil {
				transformError = fmt.Errorf("%s: %w", sourceFile.FileName(), err)
				return node
			} else if ok {
				return factory.NewBigIntLiteral(
					"0x"+strings.ToLower(hex16(value))+"n",
					ast.TokenFlagsNone,
				)
			}
			return visitor.VisitEachChild(node)
		}, factory, ast.NodeVisitorHooks{})
		statements := visitor.VisitNodes(sourceFile.Statements)
		if transformError != nil {
			return transformError
		}
		sourceFile.Statements = statements
		ast.SetParentInChildrenUnset(sourceFile.AsNode())
	}
	return nil
}

func hex16(value uint64) string {
	const digits = "0123456789abcdef"
	buffer := [16]byte{}
	for index := len(buffer) - 1; index >= 0; index-- {
		buffer[index] = digits[value&0xf]
		value >>= 4
	}
	return string(buffer[:])
}
