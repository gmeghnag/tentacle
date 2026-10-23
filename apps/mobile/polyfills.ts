import { randomUUID } from "expo-crypto";
const g = globalThis as { crypto?: { randomUUID?: () => string } };
g.crypto ??= {};
g.crypto.randomUUID ??= randomUUID;
