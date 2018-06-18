#!/usr/bin/env node

'use strict';

const options = require('commander');

/**
 * Grab command line arguments
*/
options
    .version('1.0.0')

    .option('--log-level [type]', 'Specify the log level', 'info')
    .parse(process.argv);
