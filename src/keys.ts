export async function select() {
  const keytar = await import('keytar').then(module => module.default || module);
  const inquirer = await import('inquirer');

  const credentials = await keytar.findCredentials('VALIST');
  if (credentials.length === 0) {
    throw new Error('No accounts found. Use import to add an account.');
  }

  const { account } = await inquirer.prompt([{
    name: 'account',
    message: 'Select an account',
    type: 'list',
    choices: credentials.map(c => ({ name: c.account, value: c.password })),
  }]);

  return account;
}
