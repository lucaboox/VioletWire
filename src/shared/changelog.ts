export interface ChangelogEntry {
  version: string;
  date?: string;
  additions: string[];
  improvements: string[];
  fixes: string[];
}

function parseList(section: string): string[] {
  const items: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const item = /^-\s+(.+)$/.exec(line);
    if (item) {
      items.push(item[1].trim());
      continue;
    }
    if (/^\s{2,}\S/.test(line) && items.length > 0) {
      items[items.length - 1] += ` ${line.trim()}`;
    }
  }
  return items;
}

function sectionBody(body: string, heading: string): string {
  const match = new RegExp(
    `(?:^|\\n)### ${heading}\\s*\\n([\\s\\S]*?)(?=\\n### |$)`,
    "i",
  ).exec(body);
  return match?.[1] ?? "";
}

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const releases: ChangelogEntry[] = [];
  const heading = /^## \[([^\]]+)\](?: - ([^\r\n]+))?\s*$/gm;
  const matches = [...markdown.matchAll(heading)];
  matches.forEach((match, index) => {
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? markdown.length;
    const body = markdown.slice(bodyStart, bodyEnd);
    releases.push({
      version: match[1],
      date: match[2],
      additions: parseList(sectionBody(body, "Additions")),
      improvements: parseList(sectionBody(body, "Improvements")),
      fixes: parseList(sectionBody(body, "Fixes")),
    });
  });
  return releases;
}

export function mergeChangelogEntries(
  primary: ChangelogEntry[],
  fallback: ChangelogEntry[],
): ChangelogEntry[] {
  const unreleased = fallback.find(
    (entry) => entry.version.toLowerCase() === "unreleased",
  );
  const remoteReleases = primary.filter(
    (entry) => entry.version.toLowerCase() !== "unreleased",
  );
  const seen = new Set(remoteReleases.map((entry) => entry.version.toLowerCase()));
  const fallbackReleases = fallback.filter((entry) => {
    const version = entry.version.toLowerCase();
    return version !== "unreleased" && !seen.has(version);
  });
  return [...(unreleased ? [unreleased] : []), ...remoteReleases, ...fallbackReleases];
}
