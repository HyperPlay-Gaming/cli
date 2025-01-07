import Publish from '../../src/commands/publish';
import { ethers } from 'ethers';
import { expect } from 'chai';
import { contracts, AccountMeta, ProjectMeta, Client, generateID, create } from '@valist/sdk';
import nock from 'nock';
import { CookieJar } from 'tough-cookie';
import { BrowserProvider } from 'ethers';

const url = 'https://developers.hyperplay.xyz';
const s3BaseURL = 'https://valist-hpstore.s3.us-east-005.backblazeb2.com';

const publisherPrivateKey = '4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
let provider: ethers.JsonRpcProvider;
let signer: ethers.JsonRpcSigner;
let walletPassedToPublishCommand: ethers.Wallet;

export type MockPlatform = {
    platformKey: string;
    fileName: string;
    partCount: number;
};

describe('publish CLI command', () => {
    let valist: Client;
    let members: string[] = [];
    let projectID: string;

    before(async () => {
        provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545/');
        signer = await provider.getSigner();
        walletPassedToPublishCommand = new ethers.Wallet(publisherPrivateKey, provider);
        const Registry = new ethers.ContractFactory(contracts.registryABI, contracts.registryBytecode, signer);
        const License = new ethers.ContractFactory(contracts.licenseABI, contracts.licenseBytecode, signer);

        const registry = await Registry.deploy(ethers.ZeroAddress);
        await registry.waitForDeployment();
        const registryAddress = await registry.getAddress();

        const license = await License.deploy(registry.target);
        await license.waitForDeployment();
        const licenseAddress = await license.getAddress();

        const optionsToPassToPublish = { subgraphUrl: 'http://localhost:8000/subgraphs/name/valist/dev', registryAddress, licenseAddress };
        Publish.options = optionsToPassToPublish;
        valist = await create(provider as unknown as BrowserProvider, { metaTx: false, ...optionsToPassToPublish });
        const address = await signer.getAddress();
        members = [address, walletPassedToPublishCommand.address];

        // send ETH to walletPassedToPublishCommand
        const txn = {
            to: walletPassedToPublishCommand.address,
            value: ethers.parseEther('0.5'),
        };
        await signer.sendTransaction(txn);

        const account = new AccountMeta();
        account.name = 'valist';
        account.description = 'Web3 digital distribution';

        const createAccountTx = await valist.createAccount('valist', account, members);
        await createAccountTx.wait();

        const project = new ProjectMeta();
        project.name = 'cli';
        project.description = 'Valist CLI';

        const accountID = generateID(31337, 'valist');
        const createProjectTx = await valist.createProject(accountID, 'cli', project, members);
        await createProjectTx.wait();

        projectID = generateID(accountID, 'cli');
    });

    function mockS3PresignedUrls(mockPlatforms: MockPlatform[]) {
        // Mock the generation of pre-signed URLs for each platform
        mockPlatforms.forEach(platform => {
            nock(url)
                .post('/api/v1/uploads/presigned-url')
                .reply(200, {
                    uploadDetails: [{
                        fileName: platform.fileName,
                        uploadId: 'mock-upload-id',
                        partUrls: Array.from({ length: platform.partCount }, (_, i) => ({
                            partNumber: i + 1,
                            url: `${s3BaseURL}/mock-part-url/${i + 1}`,
                        })),
                        key: `test-ground/test44/0.0.18/${platform.platformKey}/${platform.fileName}`,
                    }],
                });
        });

        // Mock successful S3 part uploads
        mockPlatforms.forEach(platform => {
            for (let i = 1; i <= platform.partCount; i++) {
                nock(s3BaseURL)
                    .put(`/mock-part-url/${i}`)
                    .reply(200, {}, { 'ETag': `mock-etag-${i}` });
            }
        });
    }

    function mockMultipartUploadCompletion(mockPlatforms: MockPlatform[]) {
        mockPlatforms.forEach(platform => {
            const parts = Array.from({ length: platform.partCount }, (_, i) => ({
                PartNumber: i + 1,
                ETag: `mock-etag-${i + 1}`,
            }));

            nock(url)
                .put('/api/v1/uploads/complete-multipart-upload', {
                    uploadId: 'mock-upload-id',
                    key: `test-ground/test44/0.0.18/${platform.platformKey}/${platform.fileName}`,
                    parts: parts
                })
                .reply(200, {
                    location: `${s3BaseURL}/test-ground/test44/0.0.18/${platform.platformKey}/${platform.fileName}`,
                });
        });
    }

    function mockAuthRequests(cookieJar: CookieJar) {
        nock(url)
            .get('/api/auth/session')
            .reply(200, { user: { address: '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1' } });

        nock(url)
            .get('/api/auth/csrf')
            .reply(200, { data: { csrfToken: 'csrf-token-mock' } });

        // Set the CSRF token in the cookie jar for subsequent requests
        cookieJar.setCookieSync('next-auth.csrf-token=csrf-token-mock', url);

        nock(url)
            .post('/api/auth/callback/ethereum')
            .reply(200, { user: { address: '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1' } });
    }

    function mockAPIRequests() {
        nock(url)
            .post('/api/v1/reviews/release')
            .reply(200, {})
            .get('/api/v1/channels')
            .reply(200, {})
            .get(`/api/v1/channels?project_id=${projectID}`)
            .reply(200, [{
                "channel_id": 307,
                "channel_name": "main",
                "license_config_id": null,
                "is_early_release": false,
                "release_meta": {
                    "name": "v0.1.1",
                    "meta_uri": "https://gateway.valist.io/ipfs/bafkreiflocbxkrbvegdpk27vh3vi4nxfvytscnel5f7bzklaagaofslzea",
                    "platforms": {
                        "windows_amd64": {
                            "name": "artifact.zip",
                            "executable": "./test.exe",
                            "installSize": "82810655",
                            "downloadSize": "82810655",
                            "external_url": "https://gateway-b3.valist.io/test/test/v0.1.67/windows_amd64/artifact.zip"
                        }
                    },
                    "project_id": "0xe7b22779eb04b720fb4a73e4076dd716408f21d460742e95875511769c43e2f8",
                    "release_id": "0x88e3ccc39166d526001f11033b09b02aef9034c073ddcd7494eb19a34ce44941",
                    "description": "Example Release",
                    "external_url": "https://gateway-b3.valist.io/test/test/v0.1.67",
                    "release_name": "v0.1.1",
                    "date_submitted": "2025-01-07T18:45:26.909+00:00"
                }
            }])
    }

    async function runPublishCommandWithMockData(releaseVersion: string, publishArgs: string[], mockPlatforms: MockPlatform[]) {
        const cookieJar = new CookieJar();
        Publish.cookieJar = cookieJar;

        mockS3PresignedUrls(mockPlatforms);  // Mock S3 URL generation
        mockMultipartUploadCompletion(mockPlatforms);  // Mock multipart upload completion
        mockAuthRequests(cookieJar);  // Mock authentication requests
        mockAPIRequests();

        try {
            await Publish.run(publishArgs);
        } catch (e: unknown) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const error = e as any;
            if (!error.oclif || error.oclif.exit !== 0) throw error;
        }

        const releaseID = valist.generateID(projectID, releaseVersion);
        const releaseExists = await valist.releaseExists(releaseID);
        expect(releaseExists).to.be.true;
        return await valist.getReleaseMeta(releaseID);
    }

    it('should create a release with the publish command and the hyperplay.yml file', async function () {
        const publishArgs = [
            `--private-key=${publisherPrivateKey}`,
            '--no-meta-tx',
            '--yml-path=./test/mock_data/hyperplay.yml',
            '--network=http://127.0.0.1:8545/',
            '--channel=main',
        ];

        const mockPlatforms = [
            { platformKey: 'darwin_amd64', fileName: 'mac_x64.zip', partCount: 1 },
            { platformKey: 'darwin_arm64', fileName: 'mac_arm64.zip', partCount: 1 },
            { platformKey: 'windows_amd64', fileName: 'windows_amd64.zip', partCount: 1 },
            { platformKey: 'web', fileName: 'web.zip', partCount: 1 },
        ];

        const releaseMeta = await runPublishCommandWithMockData('v0.0.2', publishArgs, mockPlatforms);
        const platformKeys = Object.keys(releaseMeta.platforms);
        expect(platformKeys).to.include('web');
        expect(platformKeys).to.include('darwin_amd64');
        expect(platformKeys).to.include('darwin_arm64');
        expect(platformKeys).to.include('windows_amd64');
    });

    it('should create a release with custom keys and some files and folders not zipped', async function () {
        const publishArgs = [
            `--private-key=${publisherPrivateKey}`,
            '--no-meta-tx',
            '--yml-path=./test/mock_data/hyperplay_publish.yml',
            '--network=http://127.0.0.1:8545/',
        ];

        const mockPlatforms = [
            { platformKey: 'HyperPlay-0.12.0-macOS-arm64.dmg', fileName: 'dmg.txt', partCount: 1 },
            { platformKey: 'darwin_arm64_dmg_zip_blockmap', fileName: 'mac_arm64.zip', partCount: 1 },
            { platformKey: 'windows_amd64', fileName: 'windows_amd64.zip', partCount: 1 },
            { platformKey: 'latest_mac_yml', fileName: 'web.zip', partCount: 1 },
        ];

        const releaseMeta = await runPublishCommandWithMockData('v0.0.3', publishArgs, mockPlatforms);
        const platformKeys = Object.keys(releaseMeta.platforms);
        expect(platformKeys).to.include('HyperPlay-0.12.0-macOS-arm64.dmg');
        expect(platformKeys).to.include('darwin_arm64_dmg_zip_blockmap');
        expect(platformKeys).to.include('windows_amd64');
        expect(platformKeys).to.include('latest_mac_yml');
    });
});
