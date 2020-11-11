/**
 * Copyright 2016-2018 F5 Networks, Inc.
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

const q = require('q');
const assert = require('assert');

describe('failover tests', () => {
    const region = 'aRegion';
    const clientId = 'aClient';
    const projectId = 'aProject';
    const credentials = {
        foo: 'bar'
    };

    const instanceId = 'this_is_my_instance_id';

    const vm1 = {
        name: 'vm1',
        metadata: {
            status: 'RUNNING',
        },
        getMetadata() {
            return q(
                [{
                    networkInterfaces: [
                        {
                            networkIP: '1.2.3.4',
                            accessConfigs: [
                                {
                                    natIP: '5.6.7.8'
                                }
                            ]
                        }
                    ]
                }]
            );
        }
    };

    const instance1 = {
        id: 'vm1',
        isPrimary: false
    };

    let CloudProvider;
    let GceCloudProvider;
    let provider;

    let cloudUtilMock;
    let computeMock;
    let fsMock;

    let createReadStream;

    const passedParams = {
        storage: {},
        storageBucket: {
            fileDeleteParams: []
        }
    };
    let storageBucketFileDeleteCalled = false;

    const vmSetTagsParams = {};

    // Our tests cause too many event listeners. Turn off the check.
    process.setMaxListeners(0);

    beforeEach(() => {
        /* eslint-disable global-require */
        cloudUtilMock = require('@f5devcentral/f5-cloud-libs').util;
        computeMock = require('@google-cloud/compute');

        fsMock = require('fs');

        CloudProvider = require('@f5devcentral/f5-cloud-libs').cloudProvider;
        GceCloudProvider = require('../../lib/gceCloudProvider');
        /* eslint-enable global-require */

        provider = new GceCloudProvider();
        provider.compute = {};

        cloudUtilMock.getDataFromUrl = function getDataFromUrl(url) {
            if (url.endsWith('instance/zone')) {
                return q(`projects/734288666861/zones/${region}-a`);
            } else if (url.endsWith('instance/name')) {
                return q(instanceId);
            } else if (url.endsWith('project/project-id')) {
                return q(projectId);
            }

            return q();
        };
        createReadStream = fsMock.createReadStream;
    });

    afterEach(() => {
        Object.keys(require.cache).forEach((key) => {
            delete require.cache[key];
        });
        fsMock.createReadStream = createReadStream;
    });

    describe('init tests', () => {
        it('credentials test', (done) => {
            const secretBase64 = cloudUtilMock.createBufferFrom(
                JSON.stringify(credentials)
            ).toString('base64');
            const providerOptions = {
                clientId,
                projectId,
                secret: secretBase64,
                region: 'east'
            };
            provider.init(providerOptions)
                .then(() => {
                    assert.deepEqual(provider.compute.authClient.config.credentials, credentials);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('credentials no region test', (done) => {
            const secretBase64 = cloudUtilMock.createBufferFrom(
                JSON.stringify(credentials)
            ).toString('base64');
            const providerOptions = {
                clientId,
                projectId,
                secret: secretBase64
            };
            provider.init(providerOptions)
                .then(() => {
                    assert.ok(false, 'Should have thrown no region');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('region is required'), -1);
                })
                .finally(() => {
                    done();
                });
        });

        it('no credentials test', (done) => {
            const providerOptions = { region };
            provider.init(providerOptions)
                .then(() => {
                    assert.strictEqual(provider.region, region);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('no credentials no region test', (done) => {
            const providerOptions = {};
            provider.init(providerOptions)
                .then(() => {
                    assert.strictEqual(provider.region, region);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('storage bucket no credentials test', (done) => {
            const storageBucket = 'gcp-storage-bucket';
            const providerOptions = { storageBucket };
            provider.init(providerOptions)
                .then(() => {
                    assert.strictEqual(provider.region, region);
                    assert.strictEqual(provider.storageBucket.name, storageBucket);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });
    });

    describe('get data from uri tests', () => {
        beforeEach(() => {
            provider.storage = {
                bucket(bucketParams) {
                    passedParams.storage.bucketParams = bucketParams;
                    return {
                        file(fileParams) {
                            passedParams.storage.fileParams = fileParams;
                            return {
                                download() {
                                    return q(['{"key":"value"}']);
                                },
                                getMetadata() {
                                    return q([{ contentType: 'application/json' }]);
                                }
                            };
                        }
                    };
                }
            };
        });

        it('basic test', (done) => {
            provider.getDataFromUri('gs://myBucket/myFilename')
                .then((data) => {
                    assert.strictEqual(passedParams.storage.bucketParams, 'myBucket');
                    assert.strictEqual(passedParams.storage.fileParams, 'myFilename');
                    assert.strictEqual(data.key, 'value');
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('complex key test', (done) => {
            provider.getDataFromUri('gs://myBucket/myFolder/myFilename')
                .then((data) => {
                    assert.strictEqual(passedParams.storage.bucketParams, 'myBucket');
                    assert.strictEqual(passedParams.storage.fileParams, 'myFolder/myFilename');
                    assert.strictEqual(data.key, 'value');
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('invalid uri test', (done) => {
            provider.getDataFromUri('https://console.cloud.google.com/storage/browser/bucket/key')
                .then(() => {
                    assert.ok(false, 'Should have thrown invalid URI');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('Invalid URI'), -1);
                })
                .finally(() => {
                    done();
                });
        });

        it('invalid arn test', (done) => {
            provider.getDataFromUri('gs://myBucket/')
                .then(() => {
                    assert.ok(false, 'Should have thrown invalid URI');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('Invalid URI'), -1);
                })
                .finally(() => {
                    done();
                });
        });
    });

    describe('ucs functions tests', () => {
        beforeEach(() => {
            provider.storageBucket = {
                file(fileName) {
                    passedParams.storageBucket.fileParams = fileName;
                    return {
                        save(dataToWrite) {
                            passedParams.storageBucket.fileSaveParams = dataToWrite;
                            return q();
                        },
                        delete() {
                            storageBucketFileDeleteCalled = true;
                            passedParams.storageBucket.fileDeleteParams.push(fileName);
                            return q();
                        }
                    };
                },
                getFiles(options) {
                    passedParams.storageBucket.getFiles = options;
                    return q(
                        [
                            [
                                {
                                    getMetadata() {
                                        return [
                                            {
                                                name: 'backup/ucsAutosave_123.ucs',
                                                updated: '2019-01-01T18:22:10.102Z'
                                            }
                                        ];
                                    }
                                },
                                {
                                    getMetadata() {
                                        return [
                                            {
                                                name: 'backup/ucsAutosave_234.ucs',
                                                updated: '2019-01-02T18:22:10.102Z'
                                            }
                                        ];
                                    }
                                },
                                {
                                    getMetadata() {
                                        return [
                                            {
                                                name: 'backup/ucsAutosave_345.ucs',
                                                updated: '2019-01-03T18:22:10.102Z'
                                            }
                                        ];
                                    }
                                },
                                {
                                    getMetadata() {
                                        return [
                                            {
                                                name: 'backup/ucsAutosave_456.ucs',
                                                updated: '2019-01-04T18:22:10.102Z'
                                            }
                                        ];
                                    }
                                }
                            ],
                        ]
                    );
                }
            };

            fsMock.createReadStream = () => {
                return 'string data';
            };
        });

        afterEach(() => {
            storageBucketFileDeleteCalled = false;
            passedParams.storageBucket.fileDeleteParams = [];
        });

        it('delete stored ucs test', (done) => {
            storageBucketFileDeleteCalled = false;
            provider.deleteStoredUcs('foo.ucs')
                .then(() => {
                    assert.ok(storageBucketFileDeleteCalled);
                    assert.strictEqual(passedParams.storageBucket.fileDeleteParams[0], 'backup/foo.ucs');
                })
                .catch((err) => {
                    assert.ok(false, err.message);
                })
                .finally(() => {
                    done();
                });
        });

        it('store ucs test', (done) => {
            const ucsFileName = 'ucsAutosave_123.ucs';
            const ucsFilePath = `/var/local/ucs/${ucsFileName}`;

            provider.storeUcs(ucsFilePath, 7, 'ucsAutosave_')
                .then(() => {
                    assert.strictEqual(passedParams.storageBucket.fileParams, `backup/${ucsFileName}`);
                    assert.strictEqual(passedParams.storageBucket.fileSaveParams, 'string data');
                    assert.strictEqual(storageBucketFileDeleteCalled, false);
                })
                .catch((err) => {
                    assert.ok(false, err.message);
                })
                .finally(() => {
                    done();
                });
        });

        it('store ucs delete oldest objects test', (done) => {
            const ucsFileName = 'ucsAutosave_123.ucs';
            const ucsFilePath = `/var/local/ucs/${ucsFileName}`;

            provider.storeUcs(ucsFilePath, 2, 'ucsAutosave_')
                .then(() => {
                    assert.deepEqual(passedParams.storageBucket.getFiles, { prefix: 'backup/' });
                    assert.deepEqual(
                        passedParams.storageBucket.fileDeleteParams,
                        ['backup/ucsAutosave_123.ucs', 'backup/ucsAutosave_234.ucs']
                    );
                    assert.strictEqual(storageBucketFileDeleteCalled, true);
                })
                .catch((err) => {
                    assert.ok(false, err.message);
                })
                .finally(() => {
                    done();
                });
        });
    });

    describe('elect primary tests', () => {
        it('basic test', (done) => {
            const instances = {
                1: {
                    privateIp: '1.2.3.4',
                    versionOk: true,
                    providerVisible: true
                },
                2: {
                    privateIp: '2.3.4.5',
                    versionOk: true,
                    providerVisible: true
                }
            };

            provider.electPrimary(instances)
                .then((response) => {
                    assert.strictEqual(response, '1');
                })
                .catch((err) => {
                    assert.ok(false, err.message);
                })
                .finally(() => {
                    done();
                });
        });

        it('provider not visible test', (done) => {
            const instances = {
                1: {
                    privateIp: '1.2.3.4',
                    versionOk: true,
                    providerVisible: false
                },
                2: {
                    privateIp: '2.3.4.5',
                    versionOk: true,
                    providerVisible: true
                }
            };

            provider.electPrimary(instances)
                .then((response) => {
                    assert.strictEqual(response, '2');
                })
                .catch((err) => {
                    assert.ok(false, err.message);
                })
                .finally(() => {
                    done();
                });
        });

        it('version not ok test', (done) => {
            const instances = {
                1: {
                    privateIp: '1.2.3.4',
                    versionOk: false,
                    providerVisible: true
                },
                2: {
                    privateIp: '2.3.4.5',
                    versionOk: true,
                    providerVisible: true
                }
            };

            provider.electPrimary(instances)
                .then((response) => {
                    assert.strictEqual(response, '2');
                })
                .catch((err) => {
                    assert.ok(false, err.message);
                })
                .finally(() => {
                    done();
                });
        });

        it('external test', (done) => {
            const instances = {
                1: {
                    privateIp: '1.2.3.4',
                    versionOk: true,
                    providerVisible: true
                },
                2: {
                    privateIp: '2.3.4.5',
                    versionOk: true,
                    providerVisible: true,
                    external: true
                }
            };

            provider.electPrimary(instances)
                .then((response) => {
                    assert.strictEqual(response, '2');
                })
                .catch((err) => {
                    assert.ok(false, err.message);
                })
                .finally(() => {
                    done();
                });
        });
    });

    it('get instance id test', (done) => {
        provider.getInstanceId()
            .then((response) => {
                assert.strictEqual(response, instanceId);
            })
            .catch((err) => {
                assert.ok(false, err.message);
            })
            .finally(() => {
                done();
            });
    });

    describe('get instances tests', () => {
        beforeEach(() => {
            computeMock.zone = function zone() {
                return {
                    instanceGroup() {
                        return {
                            getVMs() {
                                return [
                                    [
                                        vm1
                                    ]
                                ];
                            }
                        };
                    }
                };
            };

            provider.providerOptions = {
                instanceGroup: 'foo'
            };

            provider.storageBucket = {
                getFiles() {
                    return q([
                        [
                            {
                                download() {
                                    return [
                                        JSON.stringify(instance1)
                                    ];
                                },
                                getMetadata() {
                                    return [
                                        {
                                            name: 'instances/vm1'
                                        }
                                    ];
                                }
                            }
                        ]
                    ]);
                }
            };

            provider.compute = computeMock;
        });

        it('basic test', (done) => {
            provider.getInstances()
                .then((response) => {
                    assert.strictEqual(Object.keys(response).length, 1);
                    assert.deepEqual(response.vm1.id, instance1.id);
                    assert.deepEqual(response.vm1.isPrimary, instance1.isPrimary);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('external instances test', (done) => {
            computeMock.zone = function zone() {
                return {
                    instanceGroup() {
                        return {
                            getVMs() {
                                return [
                                    [
                                        vm1
                                    ]
                                ];
                            }
                        };
                    }
                };
            };

            provider.getVmsByTag = function getVmsByTag() {
                return q([
                    {
                        id: 'vm2',
                        ip: {
                            public: '10.11.12.13',
                            private: '15.16.17.18'
                        }
                    }
                ]);
            };

            provider.getInstances({ externalTag: 'foo' })
                .then((response) => {
                    assert.strictEqual(Object.keys(response).length, 2);
                    assert.deepEqual(response.vm2.external, true);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('missing instances test', (done) => {
            provider.storageBucket = {
                getFiles() {
                    return q([[]]);
                }
            };

            provider.getInstances()
                .then((response) => {
                    assert.strictEqual(Object.keys(response).length, 1);
                    assert.deepEqual(response.vm1.privateIp, '1.2.3.4');
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });
    });

    it('get messages test', (done) => {
        const message1 = 'i am message 1';
        const message2 = 'i am message 2';

        provider.pubSub = {
            pull() {
                return q(
                    [
                        {
                            toInstanceId: '1',
                            message: message1
                        },
                        {
                            toInstanceId: '2',
                            message: message2
                        }
                    ]
                );
            }
        };

        provider.getMessages([CloudProvider.MESSAGE_SYNC_COMPLETE], { toInstanceId: '1' })
            .then((response) => {
                assert.strictEqual(response.length, 1);
                assert.strictEqual(response[0].message, message1);
            })
            .catch((err) => {
                assert.ok(false, err);
            })
            .finally(() => {
                done();
            });
    });

    describe('get nics by tag tests', () => {
        it('basic test', (done) => {
            provider.getNicsByTag('foo')
                .then((response) => {
                    assert.strictEqual(response.length, 0);
                })
                .catch((err) => {
                    assert.ok(false, err.message);
                })
                .finally(() => {
                    done();
                });
        });
    });

    describe('get vms by tag tests', () => {
        it('basic test', (done) => {
            const myTag = {
                key: 'foo',
                value: 'bar'
            };
            const vmId = 'vm1';
            const privateIp = '1.2.3.4';
            const publicIp = '5.6.7.8';

            let passedOptions;

            provider.region = region;

            provider.compute.getVMs = function getVMs(options) {
                passedOptions = options;
                return new Promise((resolve) => {
                    resolve([[
                        {
                            id: vmId,
                            name: vmId,
                            zone: {
                                id: `${region}-a`
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
                            },
                            getMetadata() {
                                return q([this.metadata]);
                            }
                        }
                    ]]);
                });
            };

            provider.getVmsByTag(myTag)
                .then((response) => {
                    assert.deepEqual(passedOptions, { filter: `labels.${myTag.key} eq ${myTag.value}` });
                    assert.deepEqual(
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
                .catch((err) => {
                    assert.ok(false, err.message);
                })
                .finally(() => {
                    done();
                });
        });

        it('no results test', (done) => {
            const myTag = {
                key: 'foo',
                value: 'bar'
            };

            provider.compute.getVMs = function getVms() {
                return new Promise((resolve) => {
                    resolve([[]]);
                });
            };

            provider.getVmsByTag(myTag)
                .then((response) => {
                    assert.strictEqual(response.length, 0);
                })
                .catch((err) => {
                    assert.ok(false, err.message);
                })
                .finally(() => {
                    done();
                });
        });

        it('bad tag test', (done) => {
            const myTag = 'foo';

            provider.getVmsByTag(myTag)
                .then(() => {
                    assert.ok(false, 'getVmsByTag should have thrown');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('key and value'), -1);
                })
                .finally(() => {
                    done();
                });
        });

        it('error test', (done) => {
            const myTag = {
                key: 'foo',
                value: 'bar'
            };

            provider.compute.getVMs = function getVms() {
                return new Promise((resolve, reject) => {
                    reject(new Error('uh oh'));
                });
            };

            provider.getVmsByTag(myTag)
                .then(() => {
                    assert.ok(false, 'getVmsByTag should have thrown');
                })
                .catch((err) => {
                    assert.strictEqual(err.message, 'uh oh');
                })
                .finally(() => {
                    done();
                });
        });
    });

    describe('tag primary tests', () => {
        beforeEach(() => {
            const instances = {
                'bigip-bf4b': {
                    tags: [
                        'other-tag'
                    ]
                },
                'bigip-jjzs': {
                    tags: [
                        'other-tag', 'foo-primary'
                    ]
                },
                'bigip-uuio': {
                    tags: [
                        'other-tag'
                    ]
                }
            };

            computeMock.zone = function zone() {
                return {
                    vm(name) {
                        return {
                            name,
                            getTags() {
                                return [
                                    instances[name].tags,
                                    'fingerprint',
                                    { name }
                                ];
                            },
                            setTags(tags, fingerprint) {
                                vmSetTagsParams[name] = {
                                    tags,
                                    fingerprint
                                };
                                return q();
                            }
                        };
                    }
                };
            };

            provider.compute = computeMock;
        });

        it('tag primary instance test', (done) => {
            provider.providerOptions = {
                instanceGroup: 'foo'
            };

            const primaryIid = 'bigip-bf4b';
            const instances = {
                'bigip-bf4b': {
                    privateIp: '10.0.2.11'
                },
                'bigip-jjzs': {
                    privateIp: '10.0.2.11'
                },
                'bigip-uuio': {
                    privateIp: '10.0.2.12'
                }
            };

            provider.tagPrimaryInstance(primaryIid, instances)
                .then(() => {
                    assert.strictEqual(vmSetTagsParams['bigip-uuio'], undefined);
                    assert.strictEqual(vmSetTagsParams['bigip-jjzs'].tags.indexOf('foo-primary'), -1);
                    assert.notStrictEqual(vmSetTagsParams[primaryIid].tags.indexOf('foo-primary'), -1);
                    assert.strictEqual(vmSetTagsParams[primaryIid].fingerprint, 'fingerprint');
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });
    });

    it('primary elected test', (done) => {
        let instanceIdSent;
        let instanceSent;

        provider.providerOptions = {
            instanceGroup: 'foo'
        };

        provider.storageBucket = {
            getFiles() {
                return q([
                    [
                        {
                            download() {
                                return [
                                    JSON.stringify({
                                        isPrimary: true
                                    })
                                ];
                            },
                            getMetadata() {
                                return [
                                    {
                                        name: 'instances/vm1'
                                    }
                                ];
                            }
                        },
                        {
                            download() {
                                return [
                                    JSON.stringify({
                                        isPrimary: true
                                    })
                                ];
                            },
                            getMetadata() {
                                return [
                                    {
                                        name: 'instances/vm2'
                                    }
                                ];
                            }
                        }
                    ]
                ]);
            }
        };

        provider.pubSub = {
            getSubscriptions() {
                return q([[]]);
            },
            createSubscription() {
                return q();
            },
            getTopics() {
                return q([[]]);
            },
            createTopic() {
                return q();
            }
        };

        provider.putInstance = function putInstance(dbInstanceId, instance) {
            instanceIdSent = dbInstanceId;
            instanceSent = instance;
        };

        provider.primaryElected('vm1')
            .then(() => {
                assert.strictEqual(instanceIdSent, 'vm2');
                assert.strictEqual(instanceSent.isPrimary, false);
            })
            .catch((err) => {
                assert.ok(false, err);
            })
            .finally(() => {
                done();
            });
    });
});
