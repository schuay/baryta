// Prints a random key for a private gallery in site.yaml.
import { randomBytes } from 'node:crypto';

console.log(randomBytes(16).toString('base64url'));
