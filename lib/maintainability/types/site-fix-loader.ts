import type { LoadedFile, SiteFixInput } from '../../shared/types.js';

/** The file loader a fix builder receives, with what the scan attaches to it for the whole run. */
export interface ProjectLoad {
  (filename: string): LoadedFile | null;
  /** The project root, once a fix run has set it. */
  projectRoot?: string;
  /** Identifiers of the files the scan read, by file, when the scan kept them. */
  identifierIndex?: Map<string, string>;
  /** Modules other fixes of this run already create, so a new one is not given the same name. */
  createdModules?: Set<string>;
}

/** What a builder that needs the project root or the scan's index is called with. */
export type ProjectSiteFixInput = SiteFixInput & { load: ProjectLoad };
