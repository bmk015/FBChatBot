/*

 *
 */

/* jshint node: true, devel: true */
'use strict';

const
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),
  request = require('request'),
  q = require('q');

var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

/*
 * Be sure to setup your config values before running this code. You can 
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ?
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

// URL where the app is running (include protocol). Used to point to scripts and 
// assets located at this address. 
const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
    console.error("Missing config values");
    process.exit(1);
}

/*
 * Use your own validation token. Check that the token used in the Webhook 
 * setup is the same token used here.
 *
 */
app.get('/webhook', function (req, res) {
    if (req.query['hub.mode'] === 'subscribe' &&
        req.query['hub.verify_token'] === VALIDATION_TOKEN) {
        console.log("Validating webhook");
        res.status(200).send(req.query['hub.challenge']);
    } else {
        console.error("Failed validation. Make sure the validation tokens match.");
        res.sendStatus(403);
    }
});


/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function (req, res) {
    var data = req.body;

    // Make sure this is a page subscription
    if (data.object == 'page') {
        // Iterate over each entry
        // There may be multiple if batched
        data.entry.forEach(function (pageEntry) {
            var pageID = pageEntry.id;
            var timeOfEvent = pageEntry.time;

            // Iterate over each messaging event
            pageEntry.messaging.forEach(function (messagingEvent) {
                if (messagingEvent.optin) {
                    receivedAuthentication(messagingEvent);
                } else if (messagingEvent.message) {
                    receivedMessage(messagingEvent);
                } else if (messagingEvent.delivery) {
                    receivedDeliveryConfirmation(messagingEvent);
                } else if (messagingEvent.postback) {
                    receivedPostback(messagingEvent);
                } else if (messagingEvent.read) {
                    receivedMessageRead(messagingEvent);
                } else if (messagingEvent.account_linking) {
                    receivedAccountLink(messagingEvent);
                } else {
                    console.log("Webhook received unknown messagingEvent: ", messagingEvent);
                }
            });
        });

        // Assume all went well.
        //
        // You must send back a 200, within 20 seconds, to let us know you've 
        // successfully received the callback. Otherwise, the request will time out.
        res.sendStatus(200);
    }
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL. 
 * 
 */
app.get('/authorize', function (req, res) {
    var accountLinkingToken = req.query.account_linking_token;
    var redirectURI = req.query.redirect_uri;

    // Authorization Code should be generated per user by the developer. This will 
    // be passed to the Account Linking callback.
    var authCode = "1234567890";

    // Redirect users to this URI on successful login
    var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

    res.render('authorize', {
        accountLinkingToken: accountLinkingToken,
        redirectURI: redirectURI,
        redirectURISuccess: redirectURISuccess
    });
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
    var signature = req.headers["x-hub-signature"];

    if (!signature) {
        // For testing, let's log an error. In production, you should throw an 
        // error.
        console.error("Couldn't validate the signature.");
    } else {
        var elements = signature.split('=');
        var method = elements[0];
        var signatureHash = elements[1];

        var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                            .update(buf)
                            .digest('hex');

        if (signatureHash != expectedHash) {
            throw new Error("Couldn't validate the request signature.");
        }
    }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfAuth = event.timestamp;

    // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
    // The developer can set this to an arbitrary value to associate the 
    // authentication callback with the 'Send to Messenger' click event. This is
    // a way to do account linking when the user clicks the 'Send to Messenger' 
    // plugin.
    var passThroughParam = event.optin.ref;

    console.log("Received authentication for user %d and page %d with pass " +
      "through param '%s' at %d", senderID, recipientID, passThroughParam,
      timeOfAuth);

    // When an authentication is received, we'll send a message back to the sender
    // to let them know it was successful.
    sendTextMessage(senderID, "Authentication successful");
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message' 
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some 
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've 
 * created. If we receive a message with an attachment (image, video, audio), 
 * then we'll simply confirm that we've received the attachment.
 * 
 */
function receivedMessage(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfMessage = event.timestamp;
    var message = event.message;

    console.log("Received message for user %d and page %d at %d with message:",
      senderID, recipientID, timeOfMessage);
    console.log(JSON.stringify(message));

    var isEcho = message.is_echo;
    var messageId = message.mid;
    var appId = message.app_id;
    var metadata = message.metadata;

    // You may get a text or attachment but not both
    var messageText = message.text;
    var messageAttachments = message.attachments;
    var quickReply = message.quick_reply;

    if (isEcho) {
        // Just logging message echoes to console
        console.log("Received echo for message %s and app %d with metadata %s",
          messageId, appId, metadata);
        return;
    } else if (quickReply) {
        var quickReplyPayload = quickReply.payload;
        console.log("Quick reply for message %s with payload %s",
          messageId, quickReplyPayload);

        sendTextMessage(senderID, "Quick reply tapped");
        return;
    }

    if (messageText) {

        // If we receive a text message, check to see if it matches any special
        // keywords and send back the corresponding example. Otherwise, just echo
        // the text we received.
        var msgTxt = messageText.toString().toLowerCase();
        var zipcode = "60660", state = "IL";
        var amt = 6000;
        var strArry;
        //zipcode
        if (msgTxt.includes('zipcode')) {
            strArry = msgTxt.split(',');
            if (strArry.length == 2) {
                zipcode = strArry[0].split(':')[1];
                state = strArry[1].split(':')[1];
            }
            msgTxt = 'zipcode';
        }
        //find agent keyword
        if (msgTxt.includes('agent')) {
            msgTxt = 'agent';
        }
        //quote keyword
        if (msgTxt.includes('quote')) {
            msgTxt = 'quote';
        }
        //Renter keyword
        if (msgTxt.includes('renter')) {
            msgTxt = 'renter';
        }
        //address keyword
        if (msgTxt.includes('address')) {
            msgTxt = 'address';
        }
        //amount keyword
        if (msgTxt.includes('amount')) {
            var amtArry = msgTxt.split(':');
            if (amtArry.length == 2) {
                amt = amtArry[1];
            }
            msgTxt = 'amount';
        }
        switch (msgTxt) {
            case 'user_defined_payload':
            case 'hi':
            case 'hello':
                sendHelpMessage(senderID);
                break;

            case 'customer support':
                sendCustomerSupportMessage(senderID);
                break;

            case 'generic':
                sendGenericMessage(senderID);
                break;

            case 'account linking':
                sendAccountLinking(senderID);
                break;

            case 'help':
            case 'get live help':
                sendGetLiveHelpMessage(senderID);
                break;

            case 'got it':
                sendGotItMessage(senderID);
                break;
                //find an agent
            case 'agent':
                sendAgentFinderMessage(senderID);
                break;

            case 'zipcode':
                sendAgentFinderWaitMessage(senderID, zipcode, state);
                break;

            case 'agents':
                sendAgentListMessage(senderID, zipcode, state);
                break;

            case 'quote':
                sendQuoteHelpMessage(senderID);
                break;

            case 'renter':
                sendRenterQuoteHelpMessage(senderID);
                sendContactInfoMessage(senderID);
                sendContactConfirmMessage(senderID);
                break;

            case 'address':
                sendPropertyTypeMessage(senderID);
                break;

            case 'amount':
                sendQuoteResponseMessage(senderID, amt);
                break;

            default:
                sendTextMessage(senderID, messageText);
        }
    } else if (messageAttachments) {
        sendTextMessage(senderID, "Message with attachment received");
    }
}


/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var delivery = event.delivery;
    var messageIDs = delivery.mids;
    var watermark = delivery.watermark;
    var sequenceNumber = delivery.seq;

    if (messageIDs) {
        messageIDs.forEach(function (messageID) {
            console.log("Received delivery confirmation for message ID: %s",
              messageID);
        });
    }

    console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfPostback = event.timestamp;

    // The 'payload' param is a developer-defined field which is set in a postback 
    // button for Structured Messages. 
    var payload = event.postback.payload;

    console.log("Received postback for user %d and page %d with payload '%s' " +
      "at %d", senderID, recipientID, payload, timeOfPostback);

    // When a postback is called, we'll send a message back to the sender to 
    // let them know it was successful
    switch (payload.toLowerCase()) {
        case 'user_defined_payload':
            sendHelpMessage(senderID);
            break;

        case 'get live help':
            sendGetLiveHelpMessage(senderID);
            break;

        case 'got it':
            sendGotItMessage(senderID);
            break;

        case 'allstate agent':
            sendAgentFinderMessage(senderID);
            break;

        case 'contactinfocorrect':
            sendContactInfoCorrectMessage(senderID);
            break;

        case 'contactinfoincorrect':
            sendContactInfoIncorrectMessage(senderID);
            break;

        case 'house':
        case 'apartment':
        case 'dorm':
        case 'condo':
            sendPropertySelectMessage(senderID);
            break;

        default:
            sendTextMessage(senderID, payload);
    }

}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;

    // All messages before watermark (a timestamp) or sequence have been seen.
    var watermark = event.read.watermark;
    var sequenceNumber = event.read.seq;

    console.log("Received message read event for watermark %d and sequence " +
      "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;

    var status = event.account_linking.status;
    var authCode = event.account_linking.authorization_code;

    console.log("Received account link event with for user %d with status %s " +
      "and auth code %s ", senderID, status, authCode);
}

function sendAgentFinderWaitMessage(recipientId, zipcode, state) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "Wait for a moment , Finding agents near by you",
        }
    };
    callSendAPI(messageData);
    sendAgentListMessage(recipientId, zipcode, state);
}

function sendAgentFinderMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "Please enter your zip code and statecode, as 'zipcode:78745,state:IL'",
        }
    };
    callSendAPI(messageData);
}

function sendPropertySelectMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "Please enter the amount would you like to insure the content for, example Amount: 6000 ",
        }
    };
    callSendAPI(messageData);
}

function sendQuoteResponseMessage(recipientId, amount) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "Great, thanks for all the info!",
        }
    };
    callSendAPI(messageData);
    sendTypingOn(recipientId);
    sendQuoteMessage(recipientId, amount);

}


function sendTypingOn(recipientId) {
    console.log("Turning typing indicator on");

    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "typing_on"
    };

    callSendAPI(messageData);
}


function sendQuoteMessage(recipientId, amount) {
    var pr = .00333 * amount;
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "generic",
                    elements: [
                       {
                           title: "Renter Insurance Quote",
                           subtitle: "$" + pr + "/Monthly \n\r $" + amount + " Coverage",
                           image_url: SERVER_URL + "/assets/allstate_026_1_b_blue_large.jpg",
                           buttons: [
                             {
                                 type: "postback",
                                 title: "Send to Agent",
                                 payload: "Send to agent"
                             }, {
                                 type: "postback",
                                 title: "Purchase",
                                 payload: "Purchase"
                             }
                           ]
                       }
                    ]
                }
            }
        }
    };

    callSendAPI(messageData);
}

function sendGetLiveHelpMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "No problem! Would you rather talk here through messenger or chat with someone over the phone?'",
                    buttons: [{
                        type: "postback",
                        title: "Use Messenger",
                        payload: "Use Messenger"
                    }, {
                        type: "phone_number",
                        title: "Call Customer Service",
                        payload: "+16505551234"
                    }]
                }
            }
        }
    };
    callSendAPI(messageData);
}


function sendGotItMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "generic",
                    elements: [
                       {
                           title: "Lets get started",
                           subtitle: "Select one of the options below or type a message to begin",
                           image_url: SERVER_URL + "/assets/allstate_026_1_b_blue_large.jpg",
                           buttons: [
                             {
                                 type: "postback",
                                 title: "Agent Finder",
                                 payload: "Allstate agent"
                             }
                           ]
                       }
                    ]
                }
            }
        }
    };

    callSendAPI(messageData);
}

function sendQuoteHelpMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "Okay! Which product do you want a quote for",
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };

    callSendAPI(messageData);
}

function sendRenterQuoteHelpMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "starting your quote ",
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };
    callSendAPI(messageData);

}

function sendContactInfoMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "Contact Info \n\r Name: Bharath Kashinath",
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };
    callSendAPI(messageData);
}

function sendPropertyTypeMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "What type of property is it?",
                    buttons: [{
                        type: "postback",
                        title: "House",
                        payload: "House"
                    }, {
                        type: "postback",
                        title: "Apartment",
                        payload: "Apartment"
                    }, {
                        type: "postback",
                        title: "Dorm",
                        payload: "Dorm"
                    }
                    ]
                }
            }
        }
    };
    callSendAPI(messageData);
}
function sendContactConfirmMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "is this Information is accurate?",
                    buttons: [
                       {
                           type: "postback",
                           title: "Nope",
                           payload: "ContactInfoIncorrect"
                       },
                        {
                            type: "postback",
                            title: "Yes",
                            payload: "ContactInfoCorrect"
                        }
                    ]
                }
            }
        }
    }
    callSendAPI(messageData);
}

function sendContactInfoCorrectMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "OK, great now I need some info on where you currently live \n Please enter your current primary residence address",
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };
    callSendAPI(messageData);
}
/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: messageText,
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a customer support message using the Send API.
 *
 */
function sendCustomerSupportMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "Allstate Insurance Company",
                    buttons: [{
                        type: "web_url",
                        url: "https://www.allstate.com/",
                        title: "Open Web URL"
                    }, {
                        type: "phone_number",
                        title: "Call Phone Number",
                        payload: "+16505551234"
                    }]
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a help message using the Send API.
 *
 */
function sendHelpMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "Hi, I'm the Allstate Insurbot and I'm here to help \nTo get started, simply select one of the menu options below or type a question or phrase.If you need any assistance at any time,just type 'help'",
                    buttons: [
                       {
                           type: "postback",
                           title: "Got it",
                           payload: "Got it"
                       },
                        {
                            type: "postback",
                            title: "Get Live Help",
                            payload: "Get Live Help"
                        }
                    ]
                }
            }
        }
    }
    callSendAPI(messageData);
}

/*
 * Send a Structured Message (Generic Message type) using the Send API.
 *
 */
function sendGenericMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "generic",
                    elements: [{
                        title: "Allstate",
                        subtitle: "Allstate Insurance Company",
                        item_url: "https://www.allstate.com/",
                        image_url: SERVER_URL + "/assets/allstate_026_1_b_blue_large.jpg",
                        buttons: [{
                            type: "web_url",
                            url: "https://www.allstate.com/",
                            title: "Open Web URL"
                        }, {
                            type: "postback",
                            title: "Call Postback",
                            payload: "Payload for first bubble",
                        }],
                    }, {
                        title: "Auto",
                        subtitle: "Get Auto Insurance",
                        item_url: "https://www.allstate.com/auto-insurance.aspx",
                        image_url: SERVER_URL + "/assets/allstate_026_1_b_blue_large.jpg",
                        buttons: [{
                            type: "web_url",
                            url: "https://www.allstate.com/auto-insurance.aspx",
                            title: "Open Web URL"
                        }, {
                            type: "postback",
                            title: "Call Postback",
                            payload: "Payload for second bubble",
                        }]
                    }]
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "Welcome. Link your account.",
                    buttons: [{
                        type: "account_link",
                        url: SERVER_URL + "/authorize"
                    }]
                }
            }
        }
    };

    callSendAPI(messageData);
}

function sendAgentListMessage(recipientId, zipcode, state) {
    getAgentList(zipcode, state).then(function (responseObj) {
        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "generic",
                        elements: [{
                            title: responseObj.agents[0].name,
                            //title:"Isbella",
                            subtitle: "Allstate Insurance Company",
                            item_url: "https://www.allstate.com/",
                            image_url: responseObj.agents[0].imageURL || SERVER_URL + "/assets/agent2.jpg",
                            //image_url: SERVER_URL + "/assets/agent2.jpg",
                            buttons: [{
                                type: "phone_number",
                                title: "Call",
                                payload: "+16505551234"
                                //payload: responseObj.agents[0].phoneNumber
                            }, {
                                type: "postback",
                                title: "Email",
                                //payload: "xyz@gmail.com"
                                payload: responseObj.agents[0].emailAddress
                            },
                            {
                                type: "web_url",
                                url: "https://www.allstate.com/",
                                title: "View Agent's Website"
                            }]
                        }, {
                            // title: "Olivia",
                            title: responseObj.agents[1].name,
                            subtitle: "Allstate Insurance Company",
                            item_url: "https://www.allstate.com/auto-insurance.aspx",
                            image_url: responseObj.agents[1].imageURL || SERVER_URL + "/assets/agent1.png",
                            //image_url: SERVER_URL + "/assets/agent1.png",
                            buttons: [{
                                type: "phone_number",
                                title: "Call",
                                payload: "+16505551567"
                                //payload: responseObj.agents[1].phoneNumber
                            }, {
                                type: "postback",
                                title: "Email",
                                //payload: "xyz@gmail.com"
                                payload: responseObj.agents[1].emailAddress
                            },
                            {
                                type: "web_url",
                                url: "https://www.allstate.com/",
                                title: "View Agent's Website"
                            }]
                        }]
                    }
                }
            }
        };
        callSendAPI(messageData);
    });

}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callSendAPI(messageData) {
    request({
        uri: 'https://graph.facebook.com/v2.6/me/messages',
        qs: { access_token: PAGE_ACCESS_TOKEN },
        method: 'POST',
        json: messageData

    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            var recipientId = body.recipient_id;
            var messageId = body.message_id;

            if (messageId) {
                console.log("Successfully sent message with id %s to recipient %s",
                  messageId, recipientId);
            } else {
                console.log("Successfully called Send API for recipient %s",
                  recipientId);
            }
        } else {
            console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
        }
    });
}

function getAgentList(zipcode, statecode) {
    var deferred = q.defer();
    var errormsg;
    var agentlist;
    var sessionData;
    var reqUrl = "https://purchase.allstate.com/onlinesalesapp-common/api/transaction/RENTERS/sessionid";
    var agentUrl = "https://purchase.allstate.com/onlinesalesapp-common/api/common/agents";
    request({ method: 'GET', url: reqUrl }, function (error, response, body) {
        if (error || response.statusCode !== 200) {
            console.log("Error from server");
            errormsg = "Error from server session";
            deferred.resolve(errormsg);
        } else {
            //session id
            sessionData = response.headers['x-tid'];
            request({
                method: 'POST', url: agentUrl,
                headers: {
                    "content-type": "application/json",
                    "X-SID": sessionData,
                    "X-ZP": zipcode,
                    "X-TID": sessionData,
                    "X-PD": "RENTERS",
                    "X-ST": statecode
                },
                json: true,
                body: { zipCode: zipcode, street: 'sad' }
            }, function (error, response, body) {
                if (error || response.statusCode !== 200) {
                    errormsg = "Error from server gent";
                    console.log("Error from server");
                    deferred.resolve(errormsg);
                } else {
                    //Agent list
                    agentlist = body;
                    deferred.resolve(agentlist);
                }
            });
        }
    });

    return deferred.promise;
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid 
// certificate authority.
app.listen(app.get('port'), function () {
    console.log('Node app is running on port', app.get('port'));
});

module.exports = app;  

