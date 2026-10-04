// Generated source has one semantic newline representation on every host.
// Writers still emit LF; checks accept Git's CRLF checkout representation.
export function canonicalGeneratedText(text) {
  return text.replace(/\r\n?/gu, "\n");
}

export function generatedTextMatches(actual, expected) {
  return typeof actual === "string" && canonicalGeneratedText(actual) === canonicalGeneratedText(expected);
}
