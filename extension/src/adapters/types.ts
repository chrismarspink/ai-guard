export interface SiteAdapter {
  id: string;
  urls: string[];
  adapterVersion: string;
  selectors: {
    input: string;
    sendButton: string;
    fileInput?: string;
  };
  endpoints?: {
    uploadUrlPattern?: string;
  };
}
