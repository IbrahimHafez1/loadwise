import mongoose from 'mongoose';

const UserModel = mongoose.model('User', new mongoose.Schema({ name: String }));

export async function listUsers() {
  return UserModel.find({ active: true });
}
