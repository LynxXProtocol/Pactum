/* global __ENV */
import http from 'k6/http';
import { check, sleep } from 'k6';

// Benchmark Requirements:
// 10,000 req/s, P99 < 15 ms

export const options = {
  stages: [
    { duration: '30s', target: 5000 }, // Ramp up to 5k users
    { duration: '1m', target: 5000 }, // Sustain 5k users
    { duration: '30s', target: 10000 }, // Ramp up to 10k users
    { duration: '1m', target: 10000 }, // Sustain 10k users
    { duration: '30s', target: 0 }, // Ramp down to 0
  ],
  thresholds: {
    http_req_duration: ['p(99)<15'], // 99% of requests must complete below 15ms
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
// Sample test addresses
const testAddresses = [
  'GDBQZQGZXZ4RXYU3F3E5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5',
  'GABQZQGZXZ4RXYU3F3E5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5',
  'GCBQZQGZXZ4RXYU3F3E5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5',
];

export default function () {
  const address = testAddresses[Math.floor(Math.random() * testAddresses.length)];

  const responses = http.batch([
    ['GET', `${BASE_URL}/reputation/${address}`],
    ['GET', `${BASE_URL}/reputation/${address}/history?days=30`],
  ]);

  check(responses[0], {
    'status is 200 (reputation)': (r) => r.status === 200,
  });

  check(responses[1], {
    'status is 200 (history)': (r) => r.status === 200,
  });

  sleep(1);
}
