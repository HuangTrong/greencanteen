// Plugin Vite (chỉ khi đo C2): bọc điều kiện trong client/src trước khi JSX được biên dịch
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import jsx from 'acorn-jsx';
import { instrumentConditions } from '../../../tools/coverage/c2.mjs';

export const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcDir = path.join(clientRoot, 'src') + path.sep;
const JsxParser = acorn.Parser.extend(jsx());

export const parseJsx = (code, options) => JsxParser.parse(code, options);

export function c2Plugin() {
  return {
    name: 'greencanteen-c2',
    enforce: 'pre',
    transform(code, id) {
      const file = path.normalize(id.split('?')[0]);
      if (!/\.jsx?$/.test(file) || !file.startsWith(srcDir)) return null;
      const fileKey = path.relative(clientRoot, file).split(path.sep).join('/');
      return { code: instrumentConditions(code, { parse: parseJsx, fileKey }).code, map: null };
    },
  };
}
