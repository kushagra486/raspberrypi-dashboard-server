// Prompts for a dashboard password and stores only its scrypt hash in .env (mode 600).
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { hashPassword } = require('../lib/auth');

const envFile = path.join(__dirname, '..', '.env');

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); }; // hide typing
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  const pw = process.env.PI_CONSOLE_NEW_PASSWORD || await ask('New dashboard password (min 12 chars): ');
  if (pw.length < 12) { console.error('Too short: use at least 12 characters.'); process.exit(1); }
  if (!process.env.PI_CONSOLE_NEW_PASSWORD) {
    const again = await ask('Repeat password: ');
    if (again !== pw) { console.error('Passwords do not match.'); process.exit(1); }
  }
  const line = `PI_CONSOLE_PASSWORD_HASH=${hashPassword(pw)}`;
  let env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  env = env.match(/^PI_CONSOLE_PASSWORD_HASH=/m)
    ? env.replace(/^PI_CONSOLE_PASSWORD_HASH=.*$/m, line)
    : env + (env && !env.endsWith('\n') ? '\n' : '') + line + '\n';
  fs.writeFileSync(envFile, env, { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  console.log(`Saved password hash to ${envFile}. Restart the service to apply.`);
})();
