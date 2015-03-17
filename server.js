var opcua = require("node-opcua");
var express = require('express');
var app = express();
var server = require('http').createServer(app);
var io = require('socket.io')(server);
var opc_client = new opcua.OPCUAClient();

var web_connections = [];
var web_modus = "AI0";
var web_value = 0;

var opc_url = "opc.tcp://192.168.1.2:4840";
var opc_session = null;
var opc_subscription = null;
var opc_objects = {};

// Start Listening on port 80
server.listen(80, function() {
    console.log('Web server listening');
});

// Direct '/' to the web client
app.get('/', function(req, res) {
    res.sendFile(__dirname + '/web_client.html');
});

// Open connection with OPC server
opc_client.connect(opc_url, function(error) {
    if (error) {
        console.log("OPC could not connect to \"" + opc_url + "\":");
        console.log(error);
    } else {
        console.log("OPC connected.");
    }
});

// Create OPC session
function opc_connect() {
    opc_client.createSession(opc_browse);
}

// Create references for the objects in the OPC server
function opc_browse(error, session) {
    if (!error) {
        opc_session = session;
        opc_session.isRunning = 1;

        console.log("OPC session created.");

        opc_get_references("Objects/Raspberry Pi/Application/IoConfig_Globals_Mapping", function(references) {
            references.forEach(function(reference) {
                opc_objects[reference.browseName.name] = {
                    reference: reference
                };
            });

            opc_get_references("Objects/Raspberry Pi/Application/PLC_PRG", function(references) {
                references.forEach(function(reference) {
                    opc_objects[reference.browseName.name] = {
                        reference: reference
                    };
                });

                if (!opc_objects["MAN"]) {
                    opc_session.readVariableValue(opc_objects["OPC_VAL"].reference.nodeId, function(err, result) {
                        opc_objects["MAN"] = {value: result[0].value}; // Fake opc object
                        opc_subscribe();
                    });
                } else {
                    opc_subscribe();
                }
            });
        });
    } else {
        console.log("Failed to create OPC session.");
    }
}

// Initiate a subscription
function opc_subscribe() {
    opc_subscription = new opcua.ClientSubscription(opc_session, {
        requestedPublishingInterval: 100,
        requestedLifetimeCount: 10,
        requestedMaxKeepAliveCount: 2,
        maxNotificationsPerPublish: 10,
        publishingEnabled: true,
        priority: 10
    });

    opc_subscription.on("started", function() {
        console.log("OPC subscription started");
        opc_subscription.isRunning = 1;
    });
    opc_subscription.on("terminated", function() {
        delete opc_subscription.isRunning;
        console.log("OPC subscription terminated");
        opc_disconnect();
    });

    opc_install_monitors();
}

// Add objects for monitoring to the subsription
function opc_install_monitors() {
    ["AI0", "AI1"].forEach(function(objectToMonitor) {
        var monitoredItem = opc_subscription.monitor({
            nodeId: opc_objects[objectToMonitor].reference.nodeId,
            attributeId: 13
        }, {
            samplingInterval: 100,
            discardOldest: true,
            queueSize: 10
        });

        monitoredItem.on("changed", function(item) {
            opc_objects[objectToMonitor].value = item.value;

            web_connections.forEach(function(socket) {
                socket.emit('update', {
                    name: objectToMonitor,
                    value: ((item.value.value / 32767 * 100 + 0.5) | 0)
                });
            });

            if (web_modus == objectToMonitor) {
                opc_update_output(item.value);
            }
        });
    });
}

// Close the OPC session
function opc_disconnect() {

    if (opc_subscription.isRunning) {
        delete opc_subscription.isRunning;
        opc_subscription.terminate();
    } else if (opc_session.isRunning) {
        opc_session.close(function() {
            delete opc_session.isRunning;
            console.log("OPC session closed");
        });
    }
}

// Accepting web clients
io.on('connection', function(socket) {
    // Keep track of the connections
    if (web_connections.length < 1) {
        opc_connect(); // First user starts a OPC session
    }
    web_connections.push(socket);
    console.log("User connected");

    // Send the client the current state of the objects
    ["AI0, AI1", "MAN"].forEach(function(obj) {
        if (opc_objects[obj]) {
            socket.emit('update', {
                name: obj,
                value: ((opc_objects[obj].value.value / 32767 * 100 + 0.5) | 0)
            });
        }
    });

    socket.emit('update', {
        name: "web_modus",
        value: web_modus
    });

    // Client interaction
    socket.on('pot1', function() {
        web_modus = "AI0";
        web_apply_modus_change();
    });
    socket.on('pot2', function() {
        web_modus = "AI1";
        web_apply_modus_change();
    });
    socket.on('man', function() {
        web_modus = "MAN";
        web_apply_modus_change();
    });
    
    socket.on('update', function(data) {
        var i = (data / 100 * 32767)|0;
        opc_objects["MAN"].value.value = i;
        
        if (web_modus == "MAN") {
            opc_update_output(opc_objects["MAN"].value);
        }

        web_connections.forEach(function(socket) {
            socket.emit('update', {
                name: "MAN",
                value: data
            });
        });
    });

    // Remove client from connection array
    socket.on('disconnect', function() {
        console.log("User disconnected");
        web_connections.splice(web_connections.indexOf(socket), 1);
        if (web_connections.length < 1) {
            opc_disconnect(); // Last client, close session
        }
    });
});

// Browse to a path
function opcBrowseLoop(browseTo, callback, count, browseFrom) {
    if (typeof count == "undefined")
        count = 0;
    if (typeof browseFrom == "undefined")
        browseFrom = "RootFolder";

    var found = null;
    opc_session.browse(browseFrom, function(err, browse_result, diagnostics) {
        browse_result[0].references.forEach(function(reference) {
            if (reference.browseName.name == browseTo[count])
                found = reference;
        });

        if (found) {
            count++;
            if (count < browseTo.length) {
                opcBrowseLoop(browseTo, callback, count, found.nodeId);
            } else {
                callback(found);
            }
        } else {
            console.log("Could not find " + browseTo[count]);
            callback(false);
        }
    });
}

// Browse to a path and return references
function opc_get_references(path, callback) {
    var pathArray = path.split('/');
    opcBrowseLoop(pathArray, function(reference) {
        opc_session.browse(reference.nodeId, function(err, browse_result, diagnostics) {
            callback(browse_result[0].references);
        });
    });
}

// Write the correct value to the output
function opc_update_output(value) {
    //console.log(value);
    opc_session.writeSingleNode(opc_objects["OPC_VAL"].reference.nodeId, value, function() {
    });
}

// Update everything after the modus is changed
function web_apply_modus_change() {
    opc_update_output(opc_objects[web_modus].value);

    web_connections.forEach(function(socket) {
        socket.emit('update', {
            name: "web_modus",
            value: web_modus
        });
    });
}