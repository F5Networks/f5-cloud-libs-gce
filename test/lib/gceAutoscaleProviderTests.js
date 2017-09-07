/**
 * Copyright 2016-2017 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var q;
var GceAutoscaleProvider;
var provider;

// Our tests cause too many event listeners. Turn off the check.
process.setMaxListeners(0);

module.exports = {
    setUp: function(callback) {
        q = require('q');

        GceAutoscaleProvider = require('../../lib/gceAutoscaleProvider');
        provider = new GceAutoscaleProvider();

        callback();
    },

    tearDown: function(callback) {
        Object.keys(require.cache).forEach(function(key) {
            delete require.cache[key];
        });
        callback();
    },

    testGetNicsByTag: {
        testBasic: function(test) {
            test.expect(1);
            provider.getNicsByTag('foo')
                .then(function(response) {
                    test.strictEqual(response.length, 0);
                })
                .catch(function(err) {
                    test.ok(false, err.message);
                })
                .finally(function() {
                    test.done();
                });
        }
    },

    testGetVmsByTag: {
        testBasic: function(test) {
            var myTag = {
                key: 'foo',
                value: 'bar'
            };
            var vmId = 'vm1';
            var privateIp = '1.2.3.4';
            var publicIp = '5.6.7.8';
            var region = '1234';

            var passedOptions;

            provider.region = region;

            provider.compute.getVMs = function(options) {
                passedOptions = options;
                return new Promise(function(resolve) {
                    resolve([[
                        {
                            id: vmId,
                            zone: {
                                id: region + '-a'
                            },
                            metadata: {
                                networkInterfaces: [
                                    {
                                        networkIP: privateIp,
                                        accessConfigs: [
                                            {
                                                natIP: publicIp
                                            }
                                        ]
                                    }
                                ]
                            }
                        }
                    ]]);
                });
            };

            test.expect(2);
            provider.getVmsByTag(myTag)
                .then(function(response) {
                    test.deepEqual(passedOptions, { filter: 'labels.' + myTag.key + ' eq ' + myTag.value });
                    test.deepEqual(
                        response[0],
                        {
                            id: vmId,
                            ip: {
                                public: publicIp,
                                private: privateIp
                            }
                        }
                    );
                })
                .catch(function(err) {
                    test.ok(false, err.message);
                })
                .finally(function() {
                    test.done();
                });
        },

        testNoResults: function(test) {
            var myTag = {
                key: 'foo',
                value: 'bar'
            };
            var passedOptions;

            provider.compute.getVMs = function(options) {
                passedOptions = options;
                return new Promise(function(resolve) {
                    resolve([[]]);
                });
            };

            test.expect();
            provider.getVmsByTag(myTag)
                .then(function(response) {
                    test.strictEqual(response.length, 0);
                })
                .catch(function(err) {
                    test.ok(false, err.message);
                })
                .finally(function() {
                    test.done();
                });
        },

        testBadTag: function(test) {
            var myTag = 'foo';

            test.expect(1);
            provider.getVmsByTag(myTag)
                .then(function() {
                    test.ok(false, 'getVmsByTag should have thrown');
                })
                .catch(function(err) {
                    test.notStrictEqual(err.message.indexOf('key and value'), -1);
                })
                .finally(function() {
                    test.done();
                });
        },

        testError: function(test) {
            var myTag = {
                key: 'foo',
                value: 'bar'
            };

            provider.compute.getVMs = function() {
                return new Promise(function(resolve, reject) {
                    reject(new Error('uh oh'));
                });
            };

            test.expect(1);
            provider.getVmsByTag(myTag)
                .then(function() {
                    test.ok(false, 'getVmsByTag should have thrown');
                })
                .catch(function(err) {
                    test.strictEqual(err.message, 'uh oh');
                })
                .finally(function() {
                    test.done();
                });
        }
    }
};
