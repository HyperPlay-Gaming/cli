import Publish from '../../src/commands/publish';
import { ethers } from 'ethers';
import { expect } from 'chai';
import { contracts, create, AccountMeta, ProjectMeta, Client } from '@valist/sdk';
import nock from 'nock'
import { CookieJar } from 'tough-cookie';
import ganache from 'ganache'

const web3 = ganache.provider({ wallet: { deterministic: true }, 
    logging: {
        logger: {
            log: () => {} // don't do anything to prevent console spamming
        }
    } 
});

// @ts-expect-error type mismatch
const provider = new ethers.providers.Web3Provider(web3);
const signer = provider.getSigner();

const Registry = new ethers.ContractFactory(contracts.registryABI, contracts.registryBytecode, signer);
const License = new ethers.ContractFactory(contracts.licenseABI, contracts.licenseBytecode, signer);

// publishing unzipped folder is not supported only zipped or unzipped files 
describe('publish CLI command', () => {
    let valist: Client
    let members: string[] = []
    let projectID: string
    const url = 'https://developers.hyperplay.xyz'

    before(async ()=>{
        const registry = await Registry.deploy(ethers.constants.AddressZero);
        await registry.deployed();

        const license = await License.deploy(registry.address);
        await license.deployed();

        valist = await create(provider, { metaTx: false });
        const address = await signer.getAddress();
        members = [address];

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

        const accountID = valist.generateID(1337, 'valist');
        const createProjectTx = await valist.createProject(accountID, 'cli', project, members);
        await createProjectTx.wait();

        projectID = valist.generateID(accountID, 'cli');
    })

    async function runPublishCommandWithMockData(releaseVersion: string, publishArgs: string[]){
        nock(url)
            .get('/api/auth/session')
            .reply(200, {})
            .get('/api/auth/csrf')
            .reply(200, {data: {csrfToken: 'someCookieValue'}})
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
        Publish.provider = signer;
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
            '--private-key=4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d',
            '--no-meta-tx',
            '--yml-path=./test/mock_data/hyperplay.yml'
        ]
        const releaseMeta = await runPublishCommandWithMockData('v0.0.2', publishArgs)
        const platformKeys = Object.keys(releaseMeta.platforms)
        expect(platformKeys.includes('web')).true
        expect(platformKeys.includes('darwin_amd64')).true
        expect(platformKeys.includes('darwin_arm64')).true
        expect(platformKeys.includes('windows_amd64')).true
    });

    it('should create a release with custom keys and some files and folders not zipped', async function(){
        const publishArgs = [
            '--private-key=4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d',
            '--no-meta-tx',
            '--yml-path=./test/mock_data/hyperplay_publish.yml'
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
