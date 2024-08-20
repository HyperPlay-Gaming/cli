import { Command, CliUx } from '@oclif/core';
import { ethers } from 'ethers';
import { create, Options } from '@valist/sdk';
import * as flags from '../flags';
import { select } from '../keys';
import { CookieJar } from 'tough-cookie';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { login, publish } from '../api';
import { uploadRelease } from '../releases';
import { parseYml } from '../yml';
import { FlagOutput } from '@oclif/core/lib/interfaces';

export default class Publish extends Command {
  static cookieJar?: CookieJar
  static options: Partial<Options> = {}

  static description = 'Publish a release'

  static examples = [
    '<%= config.bin %> <%= command.id %> ipfs/go-ipfs/v0.12.3 README.md',
    '<%= config.bin %> <%= command.id %> ipfs/go-ipfs/v0.12.3 dist/',
  ]

  static flags = {
    'meta-tx': flags.metaTx,
    'network': flags.network,
    'private-key': flags.privateKey,
    'skip_hyperplay_publish': flags.skip_hyperplay_publish,
    'channel': flags.channel,
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

  async getWallet(network: string, privateKey: string) {
    const provider = new ethers.JsonRpcProvider(network);
    const wallet = new ethers.Wallet(privateKey, provider);
    return wallet;
  }

  /* eslint-disable-next-line */
  async parseConfig(args: { [name: string]: any; }, flags: FlagOutput) {
    const parsed = parseYml(args, flags)
    if (parsed === undefined) {
      this.error('Account, project, and release were not supplied and hyperplay.yml does not exist')
    }

    const config = parsed;
    // TODO: add zod validation
    if (!config.account) this.error('invalid account name');
    if (!config.project) this.error('invalid project name');
    if (!config.release) this.error('invalid release name');
    if (!config.platforms) this.error('no platforms configured');

    for (const [key, value] of Object.entries(config.platforms)) {
      if (!value.executable) this.error(`No executable path found for platform ${key}`)
    }

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

    const cookieJar = Publish.cookieJar ?? new CookieJar();

    const wallet = await this.getWallet(flags.network, privateKey);
    const provider = wallet.provider;
    if (provider === undefined) this.error('provider is undefined')

    const valist = await create(wallet, { metaTx, chainId: 137, ...Publish.options });

    const address = await wallet.getAddress();
    const chainId = (await provider?.getNetwork())?.chainId;
    if (provider === undefined || !chainId) {
      this.error('provider is undefined')
    }

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

    const apiURL = 'https://developers.hyperplay.xyz'
    const apiClient = wrapper(axios.create({ jar: cookieJar, withCredentials: true, baseURL: apiURL }));
    await login(
      apiClient,
      cookieJar,
      wallet
    );

    const release = await uploadRelease(apiClient, config);
    CliUx.ux.log(`Successfully uploaded files to HyperPlay: ${release.external_url}`);

    CliUx.ux.action.start('Publishing release');
    const tx = await valist.createRelease(projectID, config.release, release);
    CliUx.ux.action.stop();

    CliUx.ux.action.start(`Confirming transaction ${tx.hash}`);
    await tx.wait();
    CliUx.ux.action.stop();

    // Publish to HyperPlay
    if (!flags['skip_hyperplay_publish']) {
      await publish(
        apiClient,
        projectID,
        fullReleaseName,
        flags['channel']
      );
    }

    CliUx.ux.log(`Successfully published ${config.account}/${config.project}/${config.release}!`);
    let releaseText = 'view the release at:\n'
    if (!flags['skip_hyperplay_publish'])
      releaseText += `https://developers.hyperplay.xyz/${config.account}/${config.project}/settings\n`
    CliUx.ux.log(releaseText);

    this.exit(0);
  }
}