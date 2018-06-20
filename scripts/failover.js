#!/usr/bin/env node

'use strict';

const parser = require('commander');
const fs = require('fs');
const q = require('q');

const Compute = require('@google-cloud/compute');
const f5CloudLibs = require('@f5devcentral/f5-cloud-libs');

const util = f5CloudLibs.util;
const httpUtil = f5CloudLibs.httpUtil;
const Logger = f5CloudLibs.logger;
const compute = new Compute();

/**
 * Grab command line arguments
*/
parser
    .version('1.0.0')

    .option('--log-level [type]', 'Specify the log level', 'info')
    .option('--log-file [type]', 'Specify the log file location', '/var/log/cloud/google/failover.log')
    .option('--config-file [type]', 'Specify the log level', '/config/cloud/.deployment')
    .parse(process.argv);

const loggerOptions = { logLevel: parser.logLevel, fileName: parser.logFile, console: true };
const logger = Logger.getLogger(loggerOptions);

/** Initialize vars */
let deploymentTag;
const BASE_URL = 'https://www.googleapis.com/compute/beta';
let Zone;
let zone;
let initialized;
let accessToken;
let projectId;
let instanceName;

/** Read in configuration values */
if (fs.existsSync(parser.configFile)) {
    const cFile = JSON.parse(fs.readFileSync(parser.configFile, 'utf8'));
    deploymentTag = {
        key: cFile.tagKey,
        value: cFile.tagValue
    };
}

Promise.all([
    init(),
    getLocalMetadata('instance/zone'),
    getLocalMetadata('instance/name')
])
    .then((data) => {
        const mdataZone = data[1];
        instanceName = data[2];

        /** zone info is in the format 'projects/734288666861/zones/us-west1-a' */
        const parts = mdataZone.split('/');
        zone = parts[parts.length - 1];
        Zone = compute.zone(zone);

        logger.silly('Getting VMs');
        return getVmsByTag(deploymentTag);
    })
    .then((vms) => {
        logger.silly('Updating NICs');
        return updateNics(vms);
    })
    .then(() => {
        logger.info('Failover Complete');
    })
    .catch((err) => {
        logger.error(err.message);
    });


/**
 * Queries local metadata service for an entry
 *
 * @param {String} entry - The name of the metadata entry. For example 'instance/zone'
 *
 * @returns {Promise} A promise which is resolved with the data or rejected if an
 *                    error occurs.
 */
function getLocalMetadata(entry) {
    const options = {
        headers: {
            'Metadata-Flavor': 'Google'
        }
    };

    return util.getDataFromUrl(
        `http://metadata.google.internal/computeMetadata/v1/${entry}`,
        options
    )
        .then((data) => {
            return data;
        })
        .catch((err) => {
            const message = `Error getting metadata ${err.message}`;
            return q.reject(message);
        });
}

/**
* Get VM Metadata
*
* @param {Object} vmName - VM Name
*
* @returns {Promise} A promise which will be resolved with the metadata for the instance.
*
*/
function getVmMetadata(vmName) {
    const deferred = q.defer();

    const vm = Zone.vm(vmName);

    vm.getMetadata()
        .then((data) => {
            const metadata = data[0];
            deferred.resolve(metadata);
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
}

/**
* Initialize, pull in required metadata, etc.
*
* @returns {Promise} A promise which will be resolved upon initialization completion.
*
*/
function init() {
    if (initialized) {
        return q();
    }

    return getLocalMetadata.call(this, 'project/project-id')
        .then((resp) => {
            projectId = resp;
            return getLocalMetadata.call(this, 'instance/service-accounts/default/token');
        })
        .then((token) => {
            accessToken = token.access_token;
            initialized = true;
            return q();
        })
        .catch((err) => {
            return q.reject(new Error(`Error in initialize: ${err}`));
        });
}

/**
* Send arbitrary HTTP Request
*
* @returns {Promise} A promise which will be resolved upon complete response.
*
*/
function sendRequest(method, path, body) {
    if (!accessToken) {
        return q.reject(new Error('httpUtil.sendRequest: no auth token. call init first'));
    }
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };
    const url = `${BASE_URL}/projects/${projectId}/${path}`;

    return httpUtil.request(method, url, { headers, body });
}

/**
* Get Instance Information
*
* @param {Object} vmName - VM Name
*
* @returns {Promise} A promise which will be resolved with the metadata for the instance.
*
*/
function getVmInfo(vmName) {
    const deferred = q.defer();

    getVmMetadata(vmName)
        .then((data) => {
            deferred.resolve(data);
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
}

/**
* Updates Instance Network Interface
*
* @param {Object} vmId - Instance resource ID
*
* @param {Object} nicArr - NIC object
*
* @returns {Promise} A promise which will be resolved with the operation response.
*
*/
function updateNic(vmId, nicId, nicArr) {
    const deferred = q.defer();

    logger.info(`Updating NIC: ${nicId} for VM: ${vmId}`);
    sendRequest(
        'PATCH',
        `zones/${zone}/instances/${vmId}/updateNetworkInterface?networkInterface=${nicId}`,
        nicArr
    )
        .then((data) => {
            const operation = Zone.operation(data.name);
            return operation.promise();
        })
        .then((data) => {
            deferred.resolve(data);
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
}

/**
* Searches for VMs that have a given tag.
*
* @param {Object} tag - Tag to search for. Tag is of the format:
*
*                 {
*                     key: optional key
*                     value: value to search for
*                 }
*
* @returns {Promise} A promise which will be resolved with an array of instances.
*
*/
function getVmsByTag(tag) {
    if (!tag) {
        return q.reject(new Error('getVmsByTag: no tag, load configuration file first'));
    }
    const deferred = q.defer();

    /** Labels in GCP must be lower case */
    const options = {
        filter: `labels.${tag.key.toLowerCase()} eq ${tag.value.toLowerCase()}`
    };

    compute.getVMs(options)
        .then((vmsData) => {
            const promises = [];
            const computeVms = vmsData !== undefined ? vmsData : [[]];

            computeVms[0].forEach((vm) => {
                promises.push(getVmInfo(vm.name));
            });
            q.all(promises)
                .then((data) => {
                    deferred.resolve(data);
                })
                .catch((err) => {
                    deferred.reject(err);
                });
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
}

/**
* Determine what NICs to update
*
* @param {Object} vms - List of instances with properties
*
* @returns {Promise} A promise which will be resolved with an array of instances.
*                    Each instance value should be:
*
*/
function updateNics(vms) {
    const deferred = q.defer();

    const myVms = [];
    const theirVms = [];
    const disassociateArr = [];
    const associateArr = [];
    const aliasIpsArr = [];

    const retrier = function (fnToTry, nicArr) {
        return new Promise(
            function retryFunc(resolve, reject) {
                util.tryUntil(this, { maxRetries: 4, retryIntervalMs: 15000 }, fnToTry, nicArr)
                    .then(() => {
                        resolve();
                    })
                    .catch((error) => {
                        logger.error('Error: ', error);
                        reject(error);
                    });
            }
        );
    };

    /** Should only be one myVm */
    vms.forEach((vm) => {
        if (vm.name === instanceName) {
            myVms.push(vm);
        } else {
            theirVms.push(vm);
        }
    });

    theirVms.forEach((vm) => {
        logger.silly(`VM name: ${vm.name}`);
        vm.networkInterfaces.forEach((nic) => {
            const aliasIps = nic.aliasIpRanges;
            if (aliasIps) {
                logger.silly(`aliasIps found: ${aliasIps}`);
                /** Track all alias IPs found for inclusion on active BIG-IP */
                aliasIpsArr.push({
                    vmName: vm.name,
                    nicName: nic.name,
                    aliasIpRanges: aliasIps
                });

                /** Yank alias IPs from their VM NIC properties, target for removal */
                const theirNic = nic;
                theirNic.aliasIpRanges = [];
                disassociateArr.push([vm.name, nic.name, theirNic]);
            }
        });
    });

    /** Look through alias IP array and add to active VM's matching NIC */
    const myVm = [myVms[0]];
    myVm.forEach((vm) => {
        vm.networkInterfaces.forEach((nic) => {
            let match = false;
            const myNic = nic;
            myNic.aliasIpRanges = myNic.aliasIpRanges !== undefined ? myNic.aliasIpRanges : [];
            aliasIpsArr.forEach((ip) => {
                if (nic.name === ip.nicName) {
                    match = true;
                    ip.aliasIpRanges.forEach((alias) => {
                        myNic.aliasIpRanges.push(alias);
                    });
                }
            });
            if (match) {
                associateArr.push([vm.name, myNic.name, myNic]);
            }
        });
    });

    logger.silly(`disassociateArr: ${JSON.stringify(disassociateArr, null, 1)}`);
    logger.silly(`associateArr: ${JSON.stringify(associateArr, null, 1)}`);

    const disassociatePromises = disassociateArr.map(retrier.bind(null, updateNic));
    Promise.all(disassociatePromises)
        .then(() => {
            logger.info('Disassociate NICs successful.');
            const associatePromises = associateArr.map(retrier.bind(null, updateNic));
            return Promise.all(associatePromises);
        })
        .then(() => {
            logger.info('Associate NICs successful.');
            deferred.resolve();
        })
        .catch((error) => {
            logger.error('Error: ', error);
            deferred.reject(error);
        });

    return deferred.promise;
}
