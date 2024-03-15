import { Command, CliUx } from '@oclif/core';
import { ethers } from 'ethers';
import { create } from '@valist/sdk';
import * as flags from '../flags';
import { select } from '../keys';
import { CookieJar } from 'tough-cookie';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { loginAndPublish } from '../api';
import { uploadRelease } from '../releases';
import { parseYml } from '../yml';
import { FlagOutput } from '@oclif/core/lib/interfaces';

export default class Publish extends Command {
  static provider?: ethers.Signer;
  static cookieJar?: CookieJar

  static description = 'Publish a release'

  static examples = [
    '<%= config.bin %> <%= command.id %> ipfs/go-ipfs/v0.12.3 README.md',
    '<%= config.bin %> <%= command.id %> ipfs/go-ipfs/v0.12.3 dist/',
  ]

  static flags = {
    'meta-tx': flags.metaTx,
    'network': flags.network,
    'private-key': flags.privateKey,
    'web': flags.web,
    'darwin_amd64': flags.darwin_amd64,
    'darwin_arm64': flags.darwin_arm64,
    'windows_amd64': flags.windows_amd64,
    'skip_hyperplay_publish': flags.skip_hyperplay_publish,
    'channel': flags.channel,
    'use-yml': flags.useYml,
    'yml-path': flags.ymlPath
  }

  static args = [
    {
      name: 'account',
      description: 'account name',
      required: false
    },
    {
      name: 'project',
      description: 'project name',
      required: false
    },
    {
      name: 'release',
      description: 'release name',
      required: false
    }
  ]

  async provider(network: string, privateKey: string): Promise<ethers.Signer> {
    if (Publish.provider) return Publish.provider;

    const provider = new ethers.providers.JsonRpcProvider(network);
    return new ethers.Wallet(privateKey, provider);
  }

/* eslint-disable-next-line */
  async parseConfig(args: {[name: string]: any;}, flags: FlagOutput){
    const parsed = parseYml(args, flags)
    if (parsed === undefined){
      this.error('Account, project, and release were not supplied and hyperplay.yml does not exist')
    }

    const config = parsed;
    if (!config.account) this.error('invalid account name');
    if (!config.project) this.error('invalid project name');
    if (!config.release) this.error('invalid release name');
    if (!config.platforms) this.error('no platforms configured');

    config.account = config.account.toLowerCase();
    config.project = config.project.toLowerCase();

    return config;
  }

  // if no args are passed, use the yml
  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Publish);
    const config = await this.parseConfig(args, flags)

    const fullReleaseName = `${config.account}/${config.project}/${config.release}`;
    console.log('Publishing', { platforms: config.platforms }, `as ${fullReleaseName}`);

    const privateKey = flags['private-key'] || await select();
    const metaTx = flags['meta-tx'];

    const wallet = new ethers.Wallet(privateKey);
    const cookieJar = Publish.cookieJar ?? new CookieJar();

    const provider = await this.provider(flags.network, privateKey);
    const valist = await create(provider, { metaTx });

    const address = await provider.getAddress();
    const chainId = await provider.getChainId();

    const accountID = valist.generateID(chainId, config.account);
    const projectID = valist.generateID(accountID, config.project);
    const releaseID = valist.generateID(projectID, config.release);

    const isAccountMember = await valist.isAccountMember(accountID, address);
    const isProjectMember = await valist.isProjectMember(projectID, address);

    if (!(isAccountMember || isProjectMember)) {
      this.error('user is not an account or project member');
    }

    const releaseExists = await valist.releaseExists(releaseID);
    if (releaseExists) {
      this.error(`release ${config.release} exists`);
    }

    const release = await uploadRelease(valist, config);
    CliUx.ux.log(`successfully uploaded files to IPFS: ${release.external_url}`);

    CliUx.ux.action.start('publishing release');
    const tx = await valist.createRelease(projectID, config.release, release);
    CliUx.ux.action.stop();

    CliUx.ux.action.start(`confirming transaction ${tx.hash}`);
    await tx.wait();
    CliUx.ux.action.stop();

    // Publish to HyperPlay
    if (!flags['skip_hyperplay_publish']){
      const apiURL = 'https://developers.hyperplay.xyz'
      const apiClient = wrapper(axios.create({ jar: cookieJar, withCredentials: true, baseURL: apiURL }));
      await loginAndPublish(
        apiClient, 
        cookieJar, 
        wallet, 
        apiURL, 
        projectID,
        fullReleaseName,
        flags['channel']
      );
    }

    CliUx.ux.log(`Successfully published ${config.account}/${config.project}/${config.release}!`);
    let releaseText = 'view the release at:\n'
    if (!flags['skip_hyperplay_publish'])
      releaseText += `https://developers.hyperplay.xyz/${config.account}/${config.project}/settings\n`
    releaseText += release.external_url + '\n'
    releaseText += `ipfs://${release.external_url.replace('https://gateway.valist.io/ipfs/', '')}\n`
    CliUx.ux.log(releaseText);

    this.exit(0);
  }
}