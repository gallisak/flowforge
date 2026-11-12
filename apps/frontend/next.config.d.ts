interface HeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

declare const config: {
  output: string;
  poweredByHeader: boolean;
  headers(): Promise<HeaderRule[]>;
};

export default config;
