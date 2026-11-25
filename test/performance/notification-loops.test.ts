import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';

const files = {
  'node_modules/firebase-admin/index.d.ts': `
    export class Messaging { send(message: object): Promise<string>; sendEach(messages: object[]): Promise<unknown> }
    export function messaging(): Messaging;
  `,
  'node_modules/@sendgrid/mail/index.d.ts': `declare const mail: { send(data: object | object[]): Promise<unknown> }; export default mail;`,
  'node_modules/nodemailer/index.d.ts': `export interface Transporter { sendMail(message: object): Promise<unknown> }`,
  'node_modules/expo-server-sdk/index.d.ts': `export class Expo { sendPushNotificationsAsync(messages: object[]): Promise<unknown[]> }`,
  'node_modules/@aws-sdk/client-sns/index.d.ts': `
    export class PublishCommand { constructor(input: object) }
    export class SNSClient { send(command: PublishCommand): Promise<unknown> }
  `,
  'node_modules/other/index.d.ts': `export declare const mail: { send(data: object): Promise<unknown> };`,
};

function check(source: string) {
  return lint(source, files).filter((finding: Finding) => finding.ruleId === 'notification-send-in-loop');
}

test('reports a Firebase send per loop iteration as a default finding', () => {
  const findings = check(
    [
      "import { messaging } from 'firebase-admin';",
      'export async function run(tokens: string[]) {',
      '  for (const token of tokens) {',
      '    await messaging().send({ token });',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].contextualReason, undefined);
  assert.match(findings[0].message, /sendEach/);
});

test('reports SendGrid and Expo sends in Promise.all over map and forEach', () => {
  const findings = check(
    [
      "import mail from '@sendgrid/mail';",
      "import { Expo } from 'expo-server-sdk';",
      'declare const expo: Expo;',
      'export async function run(users: { email: string; token: string }[]) {',
      '  await Promise.all(users.map((user) => mail.send({ to: user.email })));',
      '  users.forEach(async (user) => { await expo.sendPushNotificationsAsync([{ to: user.token }]); });',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 2);
});

test('reports an SNS publish command sent through the AWS client', () => {
  const findings = check(
    [
      "import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';",
      'export async function run(client: SNSClient, arns: string[]) {',
      '  for (const arn of arns) await client.send(new PublishCommand({ TargetArn: arn }));',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /PublishBatchCommand/);
});

test('keeps a nodemailer transport send in a loop contextual', () => {
  const findings = check(
    [
      "import type { Transporter } from 'nodemailer';",
      'export async function run(transporter: Transporter, emails: string[]) {',
      '  for (const to of emails) await transporter.sendMail({ to });',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.ok(findings[0].contextualReason);
});

test('reports a project helper that wraps the provider send', () => {
  const findings = check(
    [
      "import mail from '@sendgrid/mail';",
      'async function sendWelcome(to: string) { await mail.send({ to }); }',
      'export async function run(emails: string[]) {',
      '  for (const email of emails) await sendWelcome(email);',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /project helper/);
});

test('ignores a fixed literal list, a send outside a loop and an unrelated package', () => {
  const findings = check(
    [
      "import mail from '@sendgrid/mail';",
      "import { mail as other } from 'other';",
      'export async function run(emails: string[]) {',
      "  for (const to of ['a@x.test', 'b@x.test']) await mail.send({ to });",
      "  await mail.send({ to: 'c@x.test' });",
      '  for (const to of emails) await other.send({ to });',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 0);
});
