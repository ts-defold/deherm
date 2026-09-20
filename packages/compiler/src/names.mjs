export const reservedParameterSynonyms = new Map([
  ["await", "awaitedValue"], ["break", "breakValue"], ["case", "caseValue"],
  ["catch", "caughtValue"], ["class", "classValue"], ["const", "constantValue"],
  ["continue", "continueValue"], ["debugger", "debugValue"], ["default", "defaultValue"],
  ["delete", "deletedValue"], ["do", "doValue"], ["else", "elseValue"],
  ["enum", "enumValue"], ["export", "exportedValue"], ["extends", "baseValue"],
  ["false", "falseValue"], ["finally", "finalValue"], ["for", "iterationValue"],
  ["function", "callback"], ["if", "condition"], ["import", "importedValue"],
  ["in", "input"], ["instanceof", "instanceValue"], ["interface", "interfaceValue"],
  ["let", "letValue"], ["new", "newValue"], ["null", "nullValue"],
  ["package", "packageValue"], ["private", "privateValue"], ["protected", "protectedValue"],
  ["public", "publicValue"], ["return", "returnValue"], ["static", "staticValue"],
  ["super", "base"], ["switch", "switchValue"], ["this", "receiver"],
  ["throw", "thrownValue"], ["true", "trueValue"], ["try", "tryValue"],
  ["typeof", "typeValue"], ["var", "value"], ["void", "voidValue"],
  ["while", "whileValue"], ["with", "withValue"], ["yield", "yieldedValue"]
]);

export function safeParameterIdentifier(candidate, index) {
  if (reservedParameterSynonyms.has(candidate)) return reservedParameterSynonyms.get(candidate);
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(candidate) ? candidate : `arg${index + 1}`;
}
