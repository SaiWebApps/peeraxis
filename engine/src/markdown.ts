// A small Markdown-to-HTML renderer for reports: headings, paragraphs, lists, emphasis, code, links,
// images and quotes. Everything is escaped first; links and images may only point at relative files or http(s).
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function inline(text: string, base: string): string {
  const safe = (url: string) => (/^(https?:|[\w./-]+$)/.test(url) ? (/^https?:/.test(url) ? url : `${base}${url.replace(/^\.\//, "")}`) : "#");
  return esc(text)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => `<img alt="${alt}" src="${safe(url)}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => `<a href="${safe(url)}">${label}</a>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

/** Renders `md`; relative links and images resolve under `base` (e.g. "/cards/<id>/files/"). */
export function markdown(md: string, base: string): string {
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "), base)}</p>`);
    para = [];
  };
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of md.split("\n")) {
    if (code) {
      if (line.startsWith("```")) { out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); code = null; } else code.push(line);
      continue;
    }
    if (line.startsWith("```")) { flush(); close(); code = []; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) { flush(); close(); out.push(`<h${heading[1].length + 1}>${inline(heading[2], base)}</h${heading[1].length + 1}>`); }
    else if (bullet || numbered) {
      flush();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((bullet ?? numbered)![1], base)}</li>`);
    } else if (line.startsWith(">")) { flush(); close(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""), base)}</blockquote>`); }
    else if (!line.trim()) { flush(); close(); }
    else para.push(line.trim());
  }
  if (code) out.push(`<pre><code>${esc((code as string[]).join("\n"))}</code></pre>`);
  flush();
  close();
  return out.join("\n");
}
