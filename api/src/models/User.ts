import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

const UserSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      // Normalised on write, or you end up with two accounts differing only by case.
      lowercase: true,
      trim: true,
      maxlength: 254, // RFC 5321
    },
    name: { type: String, trim: true, maxlength: 120 },

    // select: false so a stray findOne() can never leak the hash into a response.
    // Reading it requires an explicit .select('+passwordHash').
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true },
);

export type UserDoc = InferSchemaType<typeof UserSchema>;

export const User: Model<UserDoc> =
  (models.User as Model<UserDoc>) ?? model<UserDoc>('User', UserSchema);
