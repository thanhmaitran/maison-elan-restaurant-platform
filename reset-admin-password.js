'use strict';

const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const readline = require('node:readline');

const dbPath = process.env.DB_PATH ||
  path.join(__dirname, 'data', 'maison_elan.db');

const email = (process.env.ADMIN_EMAIL ||
  'tranmai15984@gmail.com').trim().toLowerCase();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

(async () => {
  let db;

  try {
    const password = await ask('Enter your new admin password: ');
    const confirm = await ask('Confirm your new admin password: ');

    if (password.length < 12 || password.length > 128) {
      throw new Error('Password must be 12–128 characters long.');
    }

    if (password !== confirm) {
      throw new Error('Passwords do not match.');
    }

    db = new DatabaseSync(dbPath);

    const admins = db.prepare(
      "SELECT id, email FROM users WHERE role = 'admin' AND lower(email) = ?"
    ).all(email);

    if (admins.length !== 1) {
      throw new Error(
        `Expected exactly one admin for ${email}; found ${admins.length}. No changes made.`
      );
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const storedPassword = `${salt}:${hash}`;

    const result = db.prepare(
      "UPDATE users SET pw = ? WHERE id = ? AND role = 'admin'"
    ).run(storedPassword, admins[0].id);

    if (Number(result.changes) !== 1) {
      throw new Error('Password update was not confirmed.');
    }

    console.log(`Admin password updated for ${email}.`);
    console.log('You can now sign in using your new password.');
  } catch (error) {
    console.error('Reset failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (db) db.close();
    rl.close();
  }
})();
