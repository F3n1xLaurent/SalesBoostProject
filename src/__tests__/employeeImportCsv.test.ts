import { describe, expect, it } from 'vitest';
import { parseEmployeeImportCsv } from '../../admin-frontend/src/pages/users/model/employeeImportCsv';
describe('employee CSV import', () => {
  it('handles BOM, semicolons, CRLF and escaped quotes', () => { expect(parseEmployeeImportCsv('\uFEFFemail;fullName;password;phone\r\na@example.test;"Иван ""Петров""";ExamplePass12;+79990000000\r\n', 'b')).toEqual([{ email: 'a@example.test', fullName: 'Иван "Петров"', password: 'ExamplePass12', phone: '+79990000000', branchId: 'b' }]); });
  it('supports comma files with quoted delimiters and branch ids per row', () => { expect(parseEmployeeImportCsv('email,fullName,branchId,password\na@example.test,"Петров, Иван",b,ExamplePass12')[0].fullName).toBe('Петров, Иван'); });
  it('rejects malformed columns, missing scope, invalid quotes and empty files', () => {
    for (const text of ['email,password\na@example.test,password', 'email,fullName,password\na@example.test,Иван,password', 'email,fullName,branchId,password\na@example.test,"Иван,b,password'])
      expect(() => parseEmployeeImportCsv(text)).toThrow();
  });
  it('rejects more than 200 employees before making an API call', () => { expect(() => parseEmployeeImportCsv('email,fullName,password\n' + Array(201).fill('a@example.test,Иван,password').join('\n'), 'b')).toThrow('200'); });
});
