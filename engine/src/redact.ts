// Removes secrets from anything the engine stores or shows.
const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
  /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}[redacted]` : "[redacted]");
  }
  return out;
}
