export interface ChangelogEntry {
  version: string;
  date?: string;
  additions: string[];
  improvements: string[];
  fixes: string[];
}

function compareVersionIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left.localeCompare(right);
}

function compareSemver(left: string, right: string): number {
  const pattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
  const leftMatch = pattern.exec(left);
  const rightMatch = pattern.exec(right);
  if (!leftMatch || !rightMatch) {
    return left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference !== 0) return difference;
  }

  const leftPrerelease = leftMatch[4]?.split(".");
  const rightPrerelease = rightMatch[4]?.split(".");
  if (!leftPrerelease && !rightPrerelease) return 0;
  if (!leftPrerelease) return 1;
  if (!rightPrerelease) return -1;

  const length = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftPrerelease[index];
    const rightIdentifier = rightPrerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const difference = compareVersionIdentifiers(leftIdentifier, rightIdentifier);
    if (difference !== 0) return difference;
  }
  return 0;
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
  const releases = [...remoteReleases, ...fallbackReleases].sort((left, right) =>
    compareSemver(right.version, left.version),
  );
  return [...(unreleased ? [unreleased] : []), ...releases];
}
