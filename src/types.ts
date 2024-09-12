export interface PlatformConfig {
    path: string
    zip: boolean
    executable: string
    installScript: string
    externalUrl?: string;
}

export type PlatformsConfig = Record<string, PlatformConfig>;

export class ReleaseConfig {
    public account: string;
    public project: string;
    public release: string;
    public image?: string;
    public description?: string;
    public source?: string;
    public platforms: PlatformsConfig;

    constructor(account: string, project: string, release: string) {
        this.account = account;
        this.project = project;
        this.release = release;
        this.platforms = {};
    }
}