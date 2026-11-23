// Deliberately vulnerable Express/Mongoose/PostgreSQL app for Loadwise recall testing ONLY.
// Scanned read-only by bench/recall/runner.cjs; never executed.
import express, { Request, Response } from 'express';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import sharp from 'sharp';
import Stripe from 'stripe';

const app = express();
const pool = new Pool();
const UserModel = mongoose.model('User', new mongoose.Schema({ email: String, password: String }));

app.get('/users', async (req: Request, res: Response) => {
  const result = await pool.query(`SELECT * FROM users WHERE email = '${req.query.email}'`);
  res.json(result.rows);
});

app.post('/login', async (req: Request, res: Response) => {
  const user = await UserModel.findOne({ email: req.body.email, password: req.body.password });
  res.json({ ok: Boolean(user) });
});

app.get('/ping', (req: Request, res: Response) => {
  exec(`ping -c 1 ${req.query.host}`, (_err, stdout) => res.send(stdout));
});

app.post('/calc', (req: Request, res: Response) => {
  const value = eval(String(req.body.expr));
  res.json({ value });
});

app.get('/download', (req: Request, res: Response) => {
  const filePath = path.join('/var/uploads', String(req.query.file));
  res.send(fs.readFileSync(filePath, 'utf8'));
});

app.get('/go', (req: Request, res: Response) => {
  res.redirect(String(req.query.next));
});

app.get('/proxy', async (req: Request, res: Response) => {
  const upstream = await fetch(String(req.query.url));
  res.send(await upstream.text());
});

app.get('/greet', (req: Request, res: Response) => {
  res.send(`<h1>Hello ${req.query.name}</h1>`);
});

const badExpRegex = /^(a+)+$/;
const badPolyRegex = /^\s+.*\s+$/;

app.get('/validate-exp', (req: Request, res: Response) => {
  res.json({ ok: badExpRegex.test(String(req.query.input)) });
});

app.get('/validate-poly', (req: Request, res: Response) => {
  res.json({ ok: badPolyRegex.test(String(req.query.input)) });
});

app.post('/register', async (req: Request, res: Response) => {
  await UserModel.create({ email: req.body.email, password: req.body.password });
  res.status(201).end();
});

app.get('/orders/:id', async (req: Request, res: Response) => {
  const id: string = req.params.id;
  const rows = await UserModel.aggregate([{ $match: { _id: id } }]);
  res.json(rows);
});

app.get('/profile/:id', async (req: Request, res: Response) => {
  const doc = await UserModel.findById(req.params.id);
  res.json(doc.toObject());
});

app.post('/avatar', async (req: Request, res: Response) => {
  const buf = await sharp(req.body).resize(256, 256).toBuffer();
  res.send(buf);
});

interface Account {
  balance: number;
}
const AccountModel = mongoose.model<Account>('Account', new mongoose.Schema<Account>({ balance: Number }));
const stripe = new Stripe(String(process.env.STRIPE_KEY));

app.post('/checkout', async (req: Request, res: Response) => {
  const account = await AccountModel.findOne({ id: req.body.accountId });
  account.balance -= Number(req.body.amount);
  await account.save();
  await stripe.paymentIntents.create({ amount: req.body.amount, currency: 'usd' });
  res.json({ ok: true });
});

app.post('/webhooks/stripe', async (req: Request, res: Response) => {
  await UserModel.create({ paid: true, ref: req.body.ref });
  res.status(200).end();
});

export async function fetchAll(urls: string[]) {
  for (const url of urls) {
    await fetch(url);
  }
}

const jwtSecret = process.env.JWT_SECRET || 'Zq8rT4mXv2LpN7cWk9';

export function attachUsers(orders: { userId: string }[], users: { id: string }[]) {
  return orders.map((order) => ({ ...order, userIndex: users.findIndex((user) => user.id === order.userId) }));
}

app.listen(3000);
