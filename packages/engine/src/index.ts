/** Public API of the Packet Trip engine. The web app may only import from here. */
export * from './model';
export { createSimulation } from './sim/simulator';
export type { Simulation, SimulationOptions, RunInfo } from './sim/simulator';
export { normalizeConfig } from './sim/scenario';
export { SITE_IDS, siteFromUrl } from './content/sites';
export { runSelfTest } from './sim/selftest';
export type { SelfTestResult } from './sim/selftest';
export { tableMeasurer, approximateMeasurer } from './browser/measure';
export type { FontTable, TextMeasurer, FontSpec } from './browser/measure';
export { buildWebCryptoMaterial, webCryptoAvailable } from './crypto/webcrypto';
export type { CryptoMaterial, KeyScheduleStep } from './crypto/types';
export { realDecrypt } from './crypto/webcrypto';
export type { RealDecryptResult, RealDecryptRecord } from './crypto/webcrypto';
export { toHex, hexRows } from './bytes/hex';
export { VIEWPORT } from './sim/web-actors';
