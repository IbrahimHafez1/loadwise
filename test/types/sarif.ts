/** The parts of a SARIF log the format tests read. */
export interface SarifRule {
  id: string;
  helpUri: string;
  shortDescription: { text: string };
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId?: string };
    region?: { startLine: number; startColumn: number };
  };
}

export interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: SarifLocation[];
  partialFingerprints: Record<string, string>;
  properties: { impact?: string };
}

export interface SarifRun {
  tool: { driver: { name: string; rules: SarifRule[] } };
  results: SarifResult[];
  automationDetails: { id: string };
  originalUriBaseIds: Record<string, { description: { text: string } }>;
}

export interface SarifLog {
  version: string;
  $schema: string;
  runs: SarifRun[];
}
