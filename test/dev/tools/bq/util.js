/*
 * Copyright 2019 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { MissingQueryError } from './missing-query-error.js';

// eslint-disable-next-line no-underscore-dangle
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * reads a query file and loads it into memory
 *
 * @param {string} query name of the query file
 */
export async function loadQuery(query) {
  const pathName = path.resolve(__dirname, './queries', `${query.replace(/^\//, '')}.sql`);
  return new Promise(((resolve, reject) => {
    fs.readFile(pathName, (err, data) => {
      if (err) {
        reject(new MissingQueryError(`Failed to load .sql file ${pathName}`));
      } else {
        resolve(data.toString('utf8'));
      }
    });
  }));
}

/**
 * strips param object of everything save headers!
 *
 * @param {string} query the content read from a query file
 * @param {object} params query parameters, that are inserted into query
 */
export function cleanHeaderParams(query, params, rmvQueryParams = false) {
  return Object.keys(params)
    .filter((key) => rmvQueryParams !== (query.match(new RegExp(`\\@${key}`, 'g')) != null))
    .filter((key) => key !== 'description')
    .reduce((cleanObj, key) => {
      // eslint-disable-next-line no-param-reassign
      cleanObj[key] = params[key];
      return cleanObj;
    }, {});
}

function coerce(value) {
  if (value === 'true') {
    return true;
  } else if (value === 'false') {
    return false;
  }
  return value;
}

/**
 * Splits the query into three parts: leading comments, query, trailing comments
 * @param {string} query a SQL query
 * @returns {object} an object with three properties: leading, query, trailing
 */
function splitQuery(query) {
  const lines = query.split('\n');
  // find the first non-comment line
  const first = lines.findIndex((line) => !line.startsWith('---'));
  // find the first SELECT statement
  const queryStart = lines.findIndex((line) => line.match(/^SELECT/i));
  // find the first comment after the query
  const queryEnd = lines.findIndex((_, i) => i > queryStart && !lines[i].startsWith('---'));

  const leading = lines
    .filter((_, i) => i < first)
    .filter((line) => line.startsWith('---'))
    .join('\n');
  const trailing = lines
    .filter((_, i) => i > queryEnd && i > queryStart)
    .filter((line) => line.startsWith('---'))
    .join('\n');
  const queryPart = lines
    .filter((_, i) => i >= queryStart && i < queryEnd)
    .join('\n');

  return {
    leading,
    query: queryPart,
    trailing,
  };
}

function getParams(query, part) {
  return splitQuery(query)[part].split('\n')
    .filter((e) => e.indexOf(':') > 0)
    .map((e) => e.substring(4).split(': '))
    .reduce((acc, val) => {
      // eslint-disable-next-line prefer-destructuring
      acc[val[0]] = coerce(val[1]);
      return acc;
    }, {});
}

/**
 * Processes additional parameters relating to query properties, like -- Authorization
 * and other properties that will be passed into request/response headers: for example;
 * --- Cache-Control: max-age: 300.
 *
 * @param {string} query the content read from a query file
 */
export function getHeaderParams(query) {
  return getParams(query, 'leading');
}

export function getTrailingParams(query) {
  return getParams(query, 'trailing');
}

/**
 * removes used up parameters from request
 *
 * @param {object} params all parameters contained in a request
 */
export function cleanRequestParams(params) {
  return Object.keys(params)
    .filter((key) => !key.match(/^[A-Z0-9_]+/))
    .filter((key) => !key.startsWith('__'))
    .reduce((cleanedobj, key) => {
      // eslint-disable-next-line no-param-reassign
      cleanedobj[key] = params[key];
      return cleanedobj;
    }, {});
}

/**
 * function checks that all parameters are not arrays.
 * @param {*} params
 * @returns
 */
export function validParamCheck(params) {
  return Object.values(params).every((param) => !(Array.isArray(param)));
}

/**
 * fills in missing query parameters (if any) with defaults from query file
 * @param {object} params provided parameters
 * @param {object} defaults default parameters in query file
 */
export function resolveParameterDiff(params, defaults) {
  const resolvedParams = Object.assign(defaults, params);
  if (validParamCheck(resolvedParams)) {
    return resolvedParams;
  } else {
    const err = new Error('Duplicate URL parameters found');
    err.statusCode = 400;
    throw err;
  }
}

function format(entry) {
  switch (typeof entry) {
    case 'boolean': return String(entry).toUpperCase();
    case 'string': return `"${entry.replace(/"/g, '""')}"`;
    default: return String(entry);
  }
}

export function csvify(arr) {
  const [first = {}] = arr;
  return [
    Array.from(Object.keys(first)).join(','),
    ...arr.map((line) => Object.values(line).map(format).join(',')),
  ].join('\n');
}

/**
 * SSHON is Simple Spreadsheet Object Notation (read: Sean, like Jason), the
 * format used by Helix to serve spreadsheets. This function converts a SQL
 * result set into a SSHON string.
 * @param {object[]} results the SQL result set
 * @param {string} description the description of the query
 * @param {object} requestParams the request parameters
 * @param {boolean} truncated whether the result set was truncated
 * @returns {string} the SSHON string
 */
export function sshonify(
  results,
  description,
  requestParams,
  responseDetails,
  responseMetadata,
  truncated,
) {
  const sson = {
    ':names': ['results', 'meta'],
    ':type': 'multi-sheet',
    ':version': 3,
    results: {
      limit: Math.max(requestParams.limit || 1, results.length),
      offset: parseInt(requestParams.offset, 10) || 0,
      total: responseMetadata.totalRows
        || results.length + Number(truncated),
      data: results,
      columns: Object.keys(results[0] || {}),
    },
    meta: {
      limit: 1 + Object.keys(requestParams).length,
      offset: 0,
      total: 1 + Object.keys(requestParams).length,
      columns: ['name', 'value', 'type'],
      data: [
        {
          name: 'description',
          value: description,
          type: 'query description',
        },
        ...Object.entries(requestParams).map(([key, value]) => ({
          name: key,
          value,
          type: 'request parameter',
        })),
        ...Object.entries(responseDetails).map(([key, value]) => ({
          name: key,
          value,
          type: 'response detail',
        })),
      ],
    },
  };
  return JSON.stringify(sson);
}
/**
 * Turn the result set into a custom chart.js object that can be used with
 * quickchart.io
 * @param {object[]} results the SQL result set
 * @param {string} description the description of the query
 * @param {object} requestParams the request parameters
 * @param {boolean} truncated whether the result set was truncated
 * @returns {object} the chartjs object
 */
export function chartify(results, description, requestParams) {
  function descend(obj) {
    if (Array.isArray(obj)) {
      return obj.map((entry) => descend(entry));
    }
    if (typeof obj === 'object') {
      return Object.keys(obj).reduce((acc, key) => {
        // eslint-disable-next-line no-param-reassign
        acc[key] = descend(obj[key]);
        return acc;
      }, {});
    }

    if (typeof obj === 'string' && obj.startsWith('@')) {
      // @columnX,@columnY to be replaced with an array of {x, y} objects
      return results
        .map((entry) => obj
          // take each segment
          .split(',')
          .map((e, i) => ({
            key: String.fromCharCode(120 + i),
            column: e.substring(1),
          }))
          .reduce((acc, { key, column }) => {
            // eslint-disable-next-line no-param-reassign
            acc[key] = entry[column];
            return acc;
          }, {}))
        // if it is a single value, then just return that value
        .map((entry) => (Object.keys(entry).length === 1
          && Object.prototype.hasOwnProperty.call(entry, 'x') ? entry.x : entry));
    }
    return obj;
  }

  try {
    const chartjson = JSON.parse(requestParams.chart);
    return JSON.stringify(descend(chartjson));
  } catch (e) {
    // chart is not JSON, so we try a brute force string replacement
    const chartstr = requestParams.chart;
    return chartstr.replace(/@([a-zA-Z0-9_]+)/g, (match, column) => {
      const data = results
        .map((entry) => entry[column])
        // if the column can be cast into a number, then use that
        .map((entry) => (Number.isNaN(Number(entry)) ? entry : Number(entry)));
      return JSON.stringify(data);
    });
  }
}
