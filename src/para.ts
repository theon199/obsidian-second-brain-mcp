import { isVaultRelativePath } from "./safety.js";

export const PARA_ROOTS = ["Inbox", "Projects", "Areas", "Resources", "Archives"] as const;

export type ParaRoot = (typeof PARA_ROOTS)[number];

export type ParaCategory = "inbox" | "project" | "area" | "resource" | "archive";

export const LIFE_TODOS_PATH = "Life/Todos.md";

export const PARA_CATEGORY_TO_ROOT: Record<ParaCategory, ParaRoot> = {
  inbox: "Inbox",
  project: "Projects",
  area: "Areas",
  resource: "Resources",
  archive: "Archives",
};

const SEED_BODY: Record<string, string> = {
  "Inbox/README.md":
    "# Inbox\n\nUnsorted captures land here. Triage with `file_note` into Projects, Areas, Resources, or Archives.\n",
  "Projects/README.md":
    "# Projects\n\nOutcome-bound work with a finish line. One subfolder per project.\n",
  "Areas/README.md":
    "# Areas\n\nOngoing life domains (health, finances, home, career). No end date.\n",
  "Resources/README.md":
    "# Resources\n\nReference material and evergreen notes.\n",
  "Archives/README.md":
    "# Archives\n\nInactive projects, areas, and resources.\n",
  [LIFE_TODOS_PATH]:
    "# Life Todos\n\nStanding life tasks live here. Add with `manage_tasks` (scope `life`) or append checkboxes.\n\n",
};

export function slugify(value: string): string {
  const slug = value
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

export function ensureMdExtension(path: string): string {
  return /\.md$/i.test(path) ? path : `${path}.md`;
}

export function basenameOf(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function dirnameOf(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  if (segments.length <= 1) return "";
  return segments.slice(0, -1).join("/");
}

export function assertSafeVaultPath(path: string): void {
  if (!isVaultRelativePath(path)) {
    throw new Error(`Path must be relative to the configured vault without '..' segments: ${path}`);
  }
}

export function isUnderParaRoot(path: string): boolean {
  assertSafeVaultPath(path);
  const normalized = path.replace(/\\/g, "/");
  return PARA_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`) || normalized === `${root}.md`,
  );
}

export function inboxCapturePath(title: string): string {
  const path = ensureMdExtension(`Inbox/${slugify(title)}`);
  assertSafeVaultPath(path);
  return path;
}

export function buildParaDestination(options: {
  category: ParaCategory;
  name?: string | undefined;
  sourcePath: string;
}): string {
  const root = PARA_CATEGORY_TO_ROOT[options.category];
  const base = ensureMdExtension(basenameOf(options.sourcePath));
  let destination: string;

  if (options.category === "inbox") {
    destination = `Inbox/${base}`;
  } else if (options.category === "project" || options.category === "area") {
    if (!options.name?.trim()) {
      throw new Error(`${options.category} filing requires a name (project or area bucket).`);
    }
    destination = `${root}/${slugify(options.name)}/${base}`;
  } else if (options.name?.trim()) {
    destination = `${root}/${slugify(options.name)}/${base}`;
  } else {
    destination = `${root}/${base}`;
  }

  assertSafeVaultPath(destination);
  if (!isUnderParaRoot(destination) && !destination.startsWith("Life/")) {
    throw new Error(`Destination must stay under a PARA root: ${destination}`);
  }
  return destination;
}

export function seedNotes(): ReadonlyArray<{ path: string; content: string }> {
  return Object.entries(SEED_BODY).map(([path, content]) => {
    assertSafeVaultPath(path);
    return { path, content };
  });
}

export function paraPropertyDefaults(category: ParaCategory, bucket?: string): Record<string, string> {
  const properties: Record<string, string> = {
    para: category,
    status: "active",
  };
  if (bucket && (category === "project" || category === "area")) {
    properties[category] = bucket;
  }
  return properties;
}

export function filterLinesUnderRoot(lines: readonly string[], root: ParaRoot): string[] {
  const prefix = `${root}/`;
  return lines.filter((line) => {
    const trimmed = line.trim().replace(/^\.\//, "");
    return trimmed === root || trimmed.startsWith(prefix) || trimmed.startsWith(`${root} `);
  });
}
