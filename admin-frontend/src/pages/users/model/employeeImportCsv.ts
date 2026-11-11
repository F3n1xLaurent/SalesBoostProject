export type EmployeeImportRow = {
  email: string;
  fullName: string;
  branchId: string;
  password: string;
  phone: string;
};
/** RFC-style quoted fields, UTF-8 BOM, comma/semicolon/tab delimiters and CRLF. */
export function parseEmployeeImportCsv(text: string, defaultBranchId = ''): EmployeeImportRow[] {
  const clean = text.replace(/^\uFEFF/, '');
  const header = clean.split(/\r?\n/, 1)[0];
  const delimiter = header.includes(';') ? ';' : header.includes('\t') ? '\t' : ',';
  const records: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        }
        else {
          quoted = false;
          closed = true;
        }
      }
      else
        field += ch;
      continue;
    }
    if (ch === '"') {
      if (field || closed)
        throw new Error('Некорректные кавычки в CSV.');
      quoted = true;
    }
    else if (ch === delimiter) {
      row.push(field);
      field = '';
      closed = false;
    }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n')
        i++;
      row.push(field);
      if (row.some(item => item.trim()))
        records.push(row);
      row = [];
      field = '';
      closed = false;
    }
    else {
      if (closed && ch.trim())
        throw new Error('После закрывающей кавычки ожидается разделитель.');
      if (!closed)
        field += ch;
    }
  }
  if (quoted)
    throw new Error('В CSV не закрыта кавычка.');
  row.push(field);
  if (row.some(item => item.trim()))
    records.push(row);
  const columns = (records.shift() ?? []).map(item => item.trim());
  const supported = ['email', 'fullName', 'branchId', 'password', 'phone'];
  if (new Set(columns).size !== columns.length || columns.some(item => !supported.includes(item)))
    throw new Error('Допустимые колонки: email, fullName, branchId, password, phone.');
  for (const key of ['email', 'fullName', 'password'])
    if (!columns.includes(key))
      throw new Error(`В CSV отсутствует колонка ${key}.`);
  if (!columns.includes('branchId') && !defaultBranchId)
    throw new Error('Добавьте колонку branchId или выберите точку для всех строк.');
  if (!records.length || records.length > 200)
    throw new Error('Файл должен содержать от 1 до 200 сотрудников.');
  return records.map((values, index) => {
    if (values.length !== columns.length)
      throw new Error(`В строке ${index + 2} неверное число колонок.`);
    const value = (key: string) => values[columns.indexOf(key)] ?? '';
    return { email: value('email').trim(), fullName: value('fullName').trim(), branchId: value('branchId').trim() || defaultBranchId, password: value('password'), phone: value('phone').trim() };
  });
}
