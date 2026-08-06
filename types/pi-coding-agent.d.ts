declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerProvider(name: string, provider: Record<string, any>): void;
  }
}
