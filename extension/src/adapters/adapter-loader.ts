import type { SiteAdapter } from "./types";

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matchAdapter(url: string, adapters: SiteAdapter[]): SiteAdapter | null {
  for (const adapter of adapters) {
    for (const pattern of adapter.urls) {
      if (globToRegExp(pattern).test(url)) return adapter;
    }
  }
  return null;
}
