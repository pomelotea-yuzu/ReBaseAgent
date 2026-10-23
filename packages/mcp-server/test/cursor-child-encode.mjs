import { createCursorCodec } from "../dist/query/cursor.js";

const input = JSON.parse(process.argv[2]);
const codec = createCursorCodec();
process.stdout.write(codec.encode(input));
