import Publish from '../../src/commands/publish';
import { ethers } from 'ethers';
import { expect } from 'chai';
import { contracts, AccountMeta, ProjectMeta, Client, generateID, create } from '@valist/sdk';
import nock from 'nock'
import { CookieJar } from 'tough-cookie';
import { BrowserProvider } from 'ethers';

const url = 'https://developers.hyperplay.xyz'
const publisherPrivateKey = '4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
let provider: ethers.JsonRpcProvider;
let signer: ethers.JsonRpcSigner;
let walletPassedToPublishCommand: ethers.Wallet;

// publishing unzipped folder is not supported only zipped or unzipped files 
describe('publish CLI command', () => {
    let valist: Client
    let members: string[] = []
    let projectID: string
    let Registry: ethers.ContractFactory<unknown[], ethers.BaseContract>
    let License: ethers.ContractFactory<unknown[], ethers.BaseContract>

    before(async () => {
        provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545/');
        signer = await provider.getSigner();
        walletPassedToPublishCommand = new ethers.Wallet(publisherPrivateKey, provider);
        Registry = new ethers.ContractFactory(contracts.registryABI, contracts.registryBytecode, signer);
        License = new ethers.ContractFactory(contracts.licenseABI, contracts.licenseBytecode, signer);

        const registry = await Registry.deploy(ethers.ZeroAddress);
        await registry.waitForDeployment()
        const registryAddress = await registry.getAddress();

        const license = await License.deploy(registry.target);
        await license.waitForDeployment()
        const licenseAddress = await license.getAddress();

        const optionsToPassToPublish = { subgraphUrl: 'http://localhost:8000/subgraphs/name/valist/dev', registryAddress, licenseAddress };
        Publish.options = optionsToPassToPublish;
        valist = await create(provider as unknown as BrowserProvider, { metaTx: false, ...optionsToPassToPublish });
        const address = await signer.getAddress();
        members = [address, walletPassedToPublishCommand.address];

        // send eth to walletPassedToPublishCommand
        const txn = {
            to: walletPassedToPublishCommand.address,
            value: ethers.parseEther('0.5')
        }
        await signer.sendTransaction(txn)

        const account = new AccountMeta();
        account.name = 'valist';
        account.description = 'Web3 digital distribution';
        account.external_url = 'https://valist.io';

        const createAccountTx = await valist.createAccount('valist', account, members);
        await createAccountTx.wait();

        const project = new ProjectMeta();
        project.name = 'cli';
        project.description = 'Valist CLI';
        project.external_url = 'https://github.com/valist-io/valist-js';

        const accountID = generateID(31337, 'valist');
        const createProjectTx = await valist.createProject(accountID, 'cli', project, members);
        await createProjectTx.wait();

        projectID = generateID(accountID, 'cli');
    })

    async function runPublishCommandWithMockData(releaseVersion: string, publishArgs: string[]) {
        nock(url)
            .get('/api/auth/session')
            .reply(200, {})
            .get('/api/auth/csrf')
            .reply(200, { data: { csrfToken: 'someCookieValue' } })
            .post('/api/v1/reviews/release')
            .reply(200, {})
            .post('/api/auth/callback/ethereum')
            .reply(200, {})
            .get('/api/v1/channels')
            .reply(200, {})
            .get(`/api/v1/channels?project_id=${projectID}`)
            .reply(200, [])

        const releaseID = valist.generateID(projectID, releaseVersion);

        const cookieJar = new CookieJar()
        cookieJar.setCookie('next-auth.csrf-token=someCookieValue', url)

        Publish.cookieJar = cookieJar
        try {
            await Publish.run(publishArgs);
            /* eslint-disable-next-line */
        } catch (e: any) {
            if (e.oclif === undefined || e.oclif.exit !== 0) throw e;
        }

        const releaseExists = await valist.releaseExists(releaseID);
        expect(releaseExists).to.be.true;
        const releaseMeta = await valist.getReleaseMeta(releaseID);
        return releaseMeta
    }

    it('should create a release with the publish command and the hyperplay.yml file', async function () {
        const publishArgs = [
            `--private-key=${publisherPrivateKey}`,
            '--no-meta-tx',
            '--yml-path=./test/mock_data/hyperplay.yml',
            '--network=http://127.0.0.1:8545/'
        ]
        const releaseMeta = await runPublishCommandWithMockData('v0.0.2', publishArgs)
        const platformKeys = Object.keys(releaseMeta.platforms)
        expect(platformKeys.includes('web')).true
        expect(platformKeys.includes('darwin_amd64')).true
        expect(platformKeys.includes('darwin_arm64')).true
        expect(platformKeys.includes('windows_amd64')).true
    });

    it('should create a release with custom keys and some files and folders not zipped', async function () {
        const publishArgs = [
            `--private-key=${publisherPrivateKey}`,
            '--no-meta-tx',
            '--yml-path=./test/mock_data/hyperplay_publish.yml',
            '--network=http://127.0.0.1:8545/'
        ]
        const releaseMeta = await runPublishCommandWithMockData('v0.0.3', publishArgs)
        console.log('release meta ', releaseMeta)
        const platformKeys = Object.keys(releaseMeta.platforms)
        expect(platformKeys.includes('HyperPlay-0.12.0-macOS-arm64.dmg')).true
        expect(platformKeys.includes('darwin_arm64_dmg_zip_blockmap')).true
        expect(platformKeys.includes('windows_amd64')).true
        expect(platformKeys.includes('latest_mac_yml')).true
        expect(releaseMeta.platforms.windows_amd64?.installScript).eq('install_deps.exe')
        expect(releaseMeta.platforms.windows_amd64?.executable).eq('test_win_x64.txt')
        expect(releaseMeta.description).to.eq('This release starts Kosium Season 1000. Can you conquer the oppressor forces stronghold on Mars?')
    })
})
