const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const filename = path.resolve('backend/api/admin.js');
const code = fs.readFileSync(filename, 'utf8');
const context = {
  require: Module.createRequire(filename),
  module: { exports: {} },
  exports: {},
  __filename: filename,
  __dirname: path.dirname(filename),
  process,
  console,
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
};
vm.createContext(context);
vm.runInContext(code, context, { filename });

const buildEmployeePerformance = context.buildEmployeePerformance;
if (typeof buildEmployeePerformance !== 'function') {
  throw new Error('buildEmployeePerformance not found');
}

const periodKey = 'custom';
const keys = {
  customStart: '2026-04-30',
  customEnd: '2026-04-30',
  prevCustomStart: null,
  prevCustomEnd: null,
  today: '2026-04-30',
  yesterday: '2026-04-29',
  weekStart: '2026-04-24',
  weekEnd: '2026-04-30',
  prevWeekStart: '2026-04-17',
  prevWeekEnd: '2026-04-23',
  month: '2026-04',
  prevMonth: '2026-03'
};
const requests = [
  {
    id: 'request-closed-prev-day',
    source_type: 'group',
    chat_id: -100902,
    customer_tg_id: 501,
    customer_name: 'Mijoz A',
    status: 'closed',
    closed_by_employee_id: 'emp-1',
    closed_by_tg_id: 777,
    closed_by_name: 'Ali Support',
    created_at: '2026-04-29T23:50:00.000Z',
    closed_at: '2026-04-30T00:05:00.000Z'
  }
];
const employees = [{ id: 'emp-1', tg_user_id: 777, full_name: 'Ali Support', username: 'ali', role: 'support', is_active: true }];
const messages = [];
const chats = [{ chat_id: -100902, title: 'Support guruhi', source_type: 'group', is_active: true }];
const companyMembers = [];

const result = buildEmployeePerformance({ requests, employees, messages, periodKey, keys, chats, companyMembers });
console.log(JSON.stringify(result, null, 2));
