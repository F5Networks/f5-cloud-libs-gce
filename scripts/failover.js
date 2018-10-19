#!/usr/bin/env node

'use strict';

const parser = require('commander');
const fs = require('fs');
const q = require('q');
const ipaddr = require('ipaddr.js');

const Compute = require('@google-cloud/compute');
const f5CloudLibs = require('@f5devcentral/f5-cloud-libs');

const util = f5CloudLibs.util;
const httpUtil = f5CloudLibs.httpUtil;
const Logger = f5CloudLibs.logger;
const compute = new Compute();

// Parse command line arguments

parser
    .version('1.0.0')

    .option('--log-level [type]', 'Specify the log level', 'info')
    .option('--log-file [type]', 'Specify the log file location', '/var/log/cloud/google/failover.log')
    .option('--config-file [type]', 'Specify the log level', '/config/cloud/.deployment')
    .parse(process.argv);

const loggerOptions = { logLevel: parser.logLevel, fileName: parser.logFile, console: true };
const logger = Logger.getLogger(loggerOptions);
const BigIp = f5CloudLibs.bigIp;
const bigip = new BigIp({ logger });

// Initialize vars
const BASE_URL = 'https://www.googleapis.com/compute/v1';
let deploymentTag;
let region;
let computeRegion;
let zone;
let computeZone;
let initialized;
let accessToken;
let projectId;
let instanceName;
let globalSettings;
let tgStats;
let virtualAddresses;

// Read in configuration values
if (fs.existsSync(parser.configFile)) {
    const cFile = JSON.parse(fs.readFileSync(parser.configFile, 'utf8'));
    deploymentTag = {
        key: cFile.tagKey,
        value: cFile.tagValue
    };
}

// Perform Failover
Promise.all([
    init(),
    bigip.init(
        'localhost',
        'admin',
        'admin',
        {
            port: '443',
        }
    )
])
    .then(() => {
        logger.info('Performing failover');
        return Promise.all([
            getLocalMetadata('instance/name'),
            getLocalMetadata('instance/zone'),
            bigip.list('/tm/sys/global-settings'),
            bigip.list('/tm/cm/traffic-group/stats'),
            bigip.list('/tm/ltm/virtual-address')
        ]);
    })
    .then((data) => {
        instanceName = data[0];
        const instanceZone = data[1];
        globalSettings = data[2];
        tgStats = data[3];
        virtualAddresses = data[4];

        // zone format: 'projects/734288666861/zones/us-west1-a'
        const parts = instanceZone.split('/');
        zone = parts[parts.length - 1];
        computeZone = compute.zone(zone);
        // unable to get region from metadata, infer from from zone
        region = zone.substring(0, zone.lastIndexOf('-'));
        computeRegion = compute.region(region);

        logger.silly('Getting GCP resources');
        return Promise.all([
            getVmsByTag(deploymentTag),
            getFwdRules(),
            getTargetInstances()
        ]);
    })
    .then((data) => {
        const vms = data[0];
        const fwdRules = data[1];
        const targetInstances = data[2];

        logger.silly('Updating GCP resources');
        return Promise.all([
            updateNics(vms),
            updateFwdRules(fwdRules, targetInstances)
        ]);
    })
    .then(() => {
        logger.info('Failover Complete');
    })
    .catch((err) => {
        logger.error(`Failover Failed: ${err.message}`);
    });

/**
 * Get local metadata for a specific entry
 *
 * @param {String} entry - The name of the metadata entry. For example 'instance/zone'
 *
 * @returns {Promise} A promise which is resolved with the metadata requested
 *
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
            const message = `Error getting local metadata ${err.message}`;
            return q.reject(new Error(message));
        });
}

/**
* Get instance metadata from GCP
*
* @param {Object} vmName - Instance Name
*
* @returns {Promise} A promise which will be resolved with the metadata for the instance
*
*/
function getVmMetadata(vmName) {
    const deferred = q.defer();
    const vm = computeZone.vm(vmName);

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
* @returns {Promise} A promise which will be resolved upon initialization completion
*
*/
function init() {
    if (initialized) {
        return q();
    }
    const deferred = q.defer();

    Promise.all([
        getLocalMetadata('project/project-id'),
        getLocalMetadata('instance/service-accounts/default/token')
    ])
        .then((data) => {
            projectId = data[0];
            accessToken = data[1].access_token;
            initialized = true;
            deferred.resolve();
        })
        .catch((err) => {
            deferred.reject(`Error in initialize: ${err}`);
        });
    return deferred.promise;
}

/**
* Send HTTP Request to GCP API (Compute)
*
* @returns {Promise} A promise which will be resolved upon complete response
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
* Get Instance Information from VM metadata
*
* @param {Object} vmName - Instance Name
*
* @returns {Promise} A promise which will be resolved with the metadata for the instance
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
* @param {Object} vmId - Instance ID
*
* @param {Object} nicId - NIC ID (name)
*
* @param {Object} nicArr - Updated NIC properties
*
* @returns {Promise} A promise which will be resolved with the operation response
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
            // updateNetworkInterface is async, returns GCP zone operation
            const operation = computeZone.operation(data.name);
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
* Updates forwarding rule target
*
* @param {Object} name - Fowarding rule name
*
* @param {Object} target - Fowarding rule target instance to set
*
* @returns {Promise} A promise which will be resolved with the operation response
*
*/
function updateFwdRule(name, target) {
    const deferred = q.defer();

    logger.info(`Updating forwarding rule: ${name} to target: ${target}`);

    const rule = computeRegion.rule(name);
    rule.setTarget(target)
        .then((data) => {
            const operationName = data[0].name;
            logger.silly(`updateFwdRule operation name: ${operationName}`);

            // returns GCP region operation, wait for that to complete
            const operation = computeRegion.operation(operationName);
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
* Get all VMs with a given tag (label)
*
* @param {Object} tag - Tag to search for. Tag should be in the format:
*
*                 {
*                     key: key to search for
*                     value: value to search for
*                 }
*
* @returns {Promise} A promise which will be resolved with an array of instances
*
*/
function getVmsByTag(tag) {
    if (!tag) {
        return q.reject(new Error('getVmsByTag: no tag, load configuration file first'));
    }
    const deferred = q.defer();

    // Labels in GCP must be lower case
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
* Get all forwarding rules (non-global)
*
* @returns {Promise} A promise which will be resolved with an array of forwarding rules
*
*/
function getFwdRules() {
    const deferred = q.defer();

    // ideally could just call compute.getRules, but that is global only
    sendRequest(
        'GET',
        `regions/${region}/forwardingRules`
    )
        .then((data) => {
            deferred.resolve(data);
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
}

/**
* Get all target instances
*
* @returns {Promise} A promise which will be resolved with an array of target instances
*
*/
function getTargetInstances() {
    const deferred = q.defer();

    // ideally could just call compute SDK, but not supported yet
    sendRequest(
        'GET',
        `zones/${zone}/targetInstances`
    )
        .then((data) => {
            deferred.resolve(data);
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
}

/**
* Retry function using tryUntil
*
* @param {Object} fnToTry                  - Function to try
*
* @param {Object} options                  - Options for function
* @param {Integer} options.retryIntervalMs - Number of times to retry.  Default 15000 ms
*
* @param {Object} arr                      - Array of arguments
*
* @returns {Promise} A promise which will be resolved with the metadata for the instance
*
*/
function retrier(fnToTry, options, arr) {
    const retryIntervalMs = options && options.retryIntervalMs ? options.retryIntervalMs : 15000;
    return new Promise(
        function retryFunc(resolve, reject) {
            util.tryUntil(this, { maxRetries: 4, retryIntervalMs }, fnToTry, arr)
                .then(() => {
                    resolve();
                })
                .catch((error) => {
                    logger.error('Error: ', error);
                    reject(error);
                });
        }
    );
}

/**
* Match IPs against a filter set of IPs
*
* @param {Object} ips - Array of IPs, support in .ipCidrRange
*
* @param {Object} ipsFilter - Array of filter IPs, support in .address
*
* @returns {Promise} A promise which will be resolved with the array of matched IPs
*
*/
function matchIps(ips, ipsFilter) {
    const matched = [];

    ips.forEach((ip) => {
        // Each IP should contain CIDR suffix
        let ipAddr = ip.ipCidrRange !== undefined ? ip.ipCidrRange : ip;
        ipAddr = ipAddr.indexOf('/') === -1 ? `${ipAddr}/32` : ipAddr;
        const ipAddrParsed = ipaddr.parseCIDR(ipAddr);
        let match = false;

        ipsFilter.forEach((ipFilter) => {
            // IP in filter array within range will constitute match
            let ipFilterAddr = ipFilter.address !== undefined ? ipFilter.address : ipFilter;
            ipFilterAddr = ipFilterAddr.split('/')[0];
            const ipFilterAddrParsed = ipaddr.parse(ipFilterAddr);
            if (ipFilterAddrParsed.match(ipAddrParsed)) {
                match = true;
            }
        });
        // Add IP to matched array if a match was found
        if (match) {
            matched.push(ip);
        }
    });
    return matched;
}

/**
* Get a list of addresses associated with any traffic group the device is active for
*
* @returns {Object} An array of addresses
*
*/
function getTgAddresses() {
    const entries = tgStats.entries;
    const hostname = globalSettings.hostname;
    const myTrafficGroupsArr = [];
    const trafficGroupIpArr = [];

    // Look through traffic group and select any we are active for
    Object.keys(entries).forEach((key) => {
        if (entries[key].nestedStats.entries.deviceName.description.includes(hostname)
        && entries[key].nestedStats.entries.failoverState.description === 'active') {
            myTrafficGroupsArr.push({
                trafficGroup: entries[key].nestedStats.entries.trafficGroup.description
            });
        }
    });

    // There should be at least one item in myTrafficGroupsArr
    if (!myTrafficGroupsArr.length) {
        const message = `We are not active for any traffic groups: ${instanceName}`;
        logger.info(message);
        return trafficGroupIpArr;
    }

    // There should be at least one item in virtualAddresses
    if (!virtualAddresses.length) {
        logger.info('No virtual addresses exist, create them prior to failover');
        return trafficGroupIpArr;
    }

    virtualAddresses.forEach((virtualAddress) => {
        const address = virtualAddress.address;
        const vaTg = virtualAddress.trafficGroup;

        myTrafficGroupsArr.forEach((tg) => {
            if (tg.trafficGroup.includes(vaTg)) {
                trafficGroupIpArr.push({
                    address
                });
            }
        });
    });
    return trafficGroupIpArr;
}

/**
* Determine what NICs to update, update any necessary
*
* @param {Object} vms - List of instances with properties
*
* @returns {Promise} A promise which will be resolved once update is complete
*
*/
function updateNics(vms) {
    const deferred = q.defer();

    const myVms = [];
    const theirVms = [];
    const aliasIpsArr = [];
    const trafficGroupIpArr = getTgAddresses();
    const disassociateArr = [];
    const associateArr = [];

    // There should be at least one item in trafficGroupIpArr
    if (!trafficGroupIpArr.length) {
        logger.info('updateNics: No traffic group address(es) exist, skipping');
        return q();
    }

    // Look through each VM and seperate us vs. them
    vms.forEach((vm) => {
        if (vm.name === instanceName) {
            myVms.push(vm);
        } else {
            theirVms.push(vm);
        }
    });

    // There should be one item in myVms
    if (!myVms.length) {
        const message = `Unable to locate our VM in the deployment: ${instanceName}`;
        logger.error(message);
        return q.reject(new Error(message));
    }

    theirVms.forEach((vm) => {
        logger.silly(`VM name: ${vm.name}`);
        vm.networkInterfaces.forEach((nic) => {
            const theirNic = nic;
            const theirAliasIps = theirNic.aliasIpRanges;
            if (theirAliasIps && theirAliasIps.length) {
                const matchingAliasIps = matchIps(theirAliasIps, trafficGroupIpArr);

                if (matchingAliasIps.length) {
                    // Track all alias IPs found for inclusion
                    aliasIpsArr.push({
                        vmName: vm.name,
                        nicName: nic.name,
                        aliasIpRanges: matchingAliasIps
                    });

                    // Yank alias IPs from their VM NIC properties, mark NIC for update
                    matchingAliasIps.forEach((myIp) => {
                        let i = 0;
                        theirAliasIps.forEach((theirIp) => {
                            if (myIp.ipCidrRange === theirIp.ipCidrRange) {
                                theirAliasIps.splice(i, 1);
                            }
                            i += 1;
                        });
                    });

                    theirNic.aliasIpRanges = theirAliasIps;
                    disassociateArr.push([vm.name, nic.name, theirNic]);
                }
            }
        });
    });

    // Look through alias IP array and add to active VM's matching NIC
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
    // debug
    logger.silly('disassociateArr:', disassociateArr);
    logger.silly(`associateArr: ${JSON.stringify(associateArr, null, 1)}`);

    const disassociatePromises = disassociateArr.map(retrier.bind(null, updateNic, {}));
    Promise.all(disassociatePromises)
        .then(() => {
            logger.info('Disassociate NICs successful');
            const associatePromises = associateArr.map(retrier.bind(null, updateNic, {}));
            return Promise.all(associatePromises);
        })
        .then(() => {
            logger.info('Associate NICs successful');
            deferred.resolve();
        })
        .catch((error) => {
            logger.error('Error: ', error);
            deferred.reject(error);
        });

    return deferred.promise;
}

/**
* Determine what forwarding rules to update, update any necessary
*
* @param {Object} fwdRules - Object containing list of forwarding rules
*
* @param {Object} targetInstances - Object containing list of forwarding rules
*
* @returns {Promise} A promise which will be resolved once update is complete
*
*/
function updateFwdRules(fwdRules, targetInstances) {
    const deferred = q.defer();
    const rules = fwdRules.items;
    const trafficGroupIpArr = getTgAddresses();
    const fwdRulesToUpdate = [];

    // There should be at least one item in trafficGroupIpArr
    if (!trafficGroupIpArr.length) {
        logger.info('updateFwdRules: No traffic group address(es) exist, skipping');
        return q();
    }

    const getOurTargetInstance = function (tgtInstances) {
        const result = [];
        tgtInstances.forEach((tgt) => {
            const tgtInstance = tgt.instance.split('/');
            const tgtInstanceName = tgtInstance[tgtInstance.length - 1];
            // check for instance name in .instance where it is an exact match
            if (tgtInstanceName === instanceName) {
                result.push({ name: tgt.name, selfLink: tgt.selfLink });
            }
        });
        return result;
    };

    const ourTargetInstances = getOurTargetInstance(targetInstances.items);
    // there should be one item in ourTargetInstances
    if (!ourTargetInstances.length) {
        const message = `Unable to locate our target instance: ${instanceName}`;
        logger.error(message);
        return q.reject(new Error(message));
    }
    const ourTargetInstance = ourTargetInstances[0];

    rules.forEach((rule) => {
        const match = matchIps([rule.IPAddress], trafficGroupIpArr);
        if (match.length) {
            logger.silly('updateFwdRules matched rule:', rule);
            if (!rule.target.includes(ourTargetInstance.name)) {
                fwdRulesToUpdate.push([rule.name, ourTargetInstance.selfLink]);
            }
        }
    });
    // debug
    logger.silly(`fwdRulesToUpdate: ${JSON.stringify(fwdRulesToUpdate, null, 1)}`);

    // longer retry interval to avoid 'resource is not ready' API response, can take 30+ seconds
    const retryIntervalMs = 60000;
    const rulesPromises = fwdRulesToUpdate.map(retrier.bind(null, updateFwdRule, { retryIntervalMs }));
    Promise.all(rulesPromises)
        .then(() => {
            logger.info('Update forwarding rules successful');
            deferred.resolve();
        })
        .catch((error) => {
            logger.error('Error: ', error);
            deferred.reject(error);
        });

    return deferred.promise;
}
