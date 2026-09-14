/** SevynOS React Native Asset Registry for Metro bundler asset resolution. */
export interface AssetData {
  readonly __packager_asset?: boolean;
  readonly fileHashes?: readonly string[];
  readonly httpServerLocation?: string;
  readonly width?: number;
  readonly height?: number;
  readonly scales?: readonly number[];
  readonly hash?: string;
  readonly name?: string;
  readonly type?: string;
  readonly uri?: string;
}

export function registerAsset(asset: AssetData): AssetData {
  return asset;
}

export default { registerAsset };
