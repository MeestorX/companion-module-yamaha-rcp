// Control module for Yamaha Pro Audio, using SCP communication
// Jack Longden <Jack@atov.co.uk> 2019
// updated by Andrew Broughton <andy@checkcheckonetwo.com>
// June 16, 2021 Version 1.6.0

var tcp 			= require('../../tcp');
var instance_skel 	= require('../../instance_skel');
var shortid			= require('shortid');
var scpNames 		= require('./scpNames.json');
var upgrade			= require('./upgrade');
var paramFuncs		= require('./paramFuncs');

const SCP_VALS 		= ['Status', 'Command', 'Address', 'X', 'Y', 'Val', 'TxtVal'];


// Instance Setup
class instance extends instance_skel {
	
	constructor(system, id, config) {
		super(system, id, config);

		Object.assign(this, {
			...upgrade, paramFuncs,
		});
		
		this.scpCommands   = [];
		this.nameCommands  = []; 	// Commands which have a name field
		this.colorCommands = [];	// Commands which have a color field
		this.scpPresets    = [];
		this.productName   = '';
		this.macroRec      = false;
		this.macroCount    = 0;
		this.macroMode     = 'latch';
		this.macro         = {};
		this.dataStore     = {};

	}

	static DEVELOPER_forceStartupUpgradeScript = 0;

	static GetUpgradeScripts() {
		return [
			upgrade.upg111to112,
			upgrade.upg112to113,
			upgrade.upg113to160
		]
	}

	
	// Startup
	init() {
		this.updateConfig(this.config);
	}


	// Module deletion
	destroy() {
	
		if (this.socket !== undefined) {
			this.socket.destroy();
		}

		this.log('debug', `destroyed ${this.id}`);
	}


	// Web config fields
	config_fields() {
		
		let fields = [
			{
				type: 		'textinput',
				id: 		'host',
				label: 		'IP Address of Console',
				width: 		6,
				default: 	'192.168.0.128',
				regex: 		this.REGEX_IP
			},
			{
				type: 		'dropdown',
				id: 		'model',
				label: 		'Console Type',
				width: 		6,
				default: 	'CL/QL',
				choices: [
					{id: 'CL/QL', label: 'CL/QL Console'},
					{id: 'TF', label: 'TF Console'},
					{id: 'PM', label: 'Rivage Console'}
				]
			}
		]
		for(let i = 1; i <= 4; i++){
			fields.push({
				type: 		'textinput',
				id: 		`myChName${i}`,
				label: 		`My Channel #${i} Name`,
				width: 		6,
				default: 	`My Channel ${i}`,
			},
			{
				type: 		'number',
				id: 		`myCh${i}`,
				label: 		`Channel #${i}`,
				width:		2,
				min: 		1,
				max: 		72,
				default: 	1,
				required: 	false
			})
		}
		return fields;
	}

	
	// Change in Configuration
	updateConfig(config) {

		this.config = config;
		this.scpCommands = paramFuncs.getParams(config);
		this.newConsole();

	}


	// Whenever the console type changes, update the info
	newConsole() {
		
		this.log('info', `Device model= ${this.config.model}`);
		
		this.actions(); // Re-do the actions once the console is chosen
		this.presets();
		this.init_tcp();

//console.log(this.config);
	}

	// Get info from a connected console
	getConsoleInfo() {
		this.socket.send(`devinfo productname\n`);
	}


	// Initialize TCP
	init_tcp() {
		
		let receivebuffer  = '';
		let receivedLines  = [];
		let receivedcmds   = [];
		let foundCmd	   = {};
		
		if (this.socket !== undefined) {
			this.socket.destroy();
			delete this.socket;
		}

		if (this.config.host) {
			this.socket = new tcp(this.config.host, 49280);

			this.socket.on('status_change', (status, message) => {
				this.status(status, message);
			});

			this.socket.on('error', (err) => {
				this.status(this.STATUS_ERROR, err);
				this.log('error', `Network error: ${err.message}`);
			});

			this.socket.on('connect', () => {
				this.status(this.STATUS_OK);
				this.log('info', `Connected!`);
				this.getConsoleInfo();
				this.pollScp();
			});

			this.socket.on('data', (chunk) => {
				receivebuffer += chunk;
				
				receivedLines = receivebuffer.split("\x0A");	// Split by line break
				if (receivedLines.length == 0) return;	// No messages

//console.log(`Incoming:\n${receivebuffer}`);				

				if (receivebuffer.slice(-1) != "\x0A") {
					receivebuffer = receivedLines[receivedLines.length - 1] // Broken line, leave it for next time...
					receivedLines.splice(receivedLines.length - 1); // Remove it.
				} else {
					receivebuffer = '';
				}

//console.log(`Remaining: ${receivebuffer}`);

				for (let line of receivedLines){
					if (line.length == 0) {
						continue;
					} 

					this.log('debug', `Received: '${line}'`);

					if (line.indexOf('OK devinfo productname') !== -1) {
					
						this.productName = line.slice(line.lastIndexOf(" "));
						this.log('info', `Device found: ${this.productName}`);
					
					} else {
					
						receivedcmds = paramFuncs.parseData(line, SCP_VALS); // Break out the parameters
//console.log(receivedcmds);						
						for (let i=0; i < receivedcmds.length; i++) {
							let cmdToFind = receivedcmds[i].Address;
//console.log(cmdToFind);
							foundCmd = this.scpCommands.find(cmd => cmd.Address == cmdToFind.slice(0, cmd.Address.length)); // Find which command

							if (foundCmd !== undefined) {
									this.addToDataStore({scp: foundCmd, cmd: receivedcmds[i]})
									this.addMacro({scp: foundCmd, cmd: receivedcmds[i]});
									this.checkFeedbacks();							
							} else {
							
								this.log('debug', `Unknown command received: '${receivedcmds[i].Address}'`);
							
							}
						}
					}
				}				
			});
		}
	}



	// Create single Action/Feedback
	createAction(scpCmd) {
		
		let newAction = {};
		let valParams = {};
		let scpLabel  = '';

		if (this.config.model == 'TF' && scpCmd.Type == 'scene') {
			scpLabel = 'Scene/Bank'
		} else {
			scpLabel = scpCmd.Address.slice(scpCmd.Address.indexOf("/") + 1); // String after "MIXER:Current/"
		}
		
		// Add the commands from the data file. Action id's (action.action) are the SCP command number
		let scpLabels = scpLabel.split("/");
		let scpLabelIdx = (scpLabel.startsWith("Cue")) ? 1 : 0;
		
		newAction = {label: scpLabel, options: []};
		if (scpCmd.X > 1) {
			if (scpLabel.startsWith("InCh") || scpLabel.startsWith("Cue/InCh")) {
				newAction.options = [
					{type: 'dropdown', label: scpLabels[scpLabelIdx], id: 'X', default: 1, minChoicesForSearch: 0, choices: scpNames.chNames.slice(0, parseInt(scpCmd.X) + 4)}
				]
			} else {
				newAction.options = [
					{type: 'number', label: scpLabels[scpLabelIdx], id: 'X', min: 1, max: scpCmd.X, default: 1, required: true, range: false}
				]
			}
			scpLabelIdx++;
		}

		if (scpCmd.Y > 1) {
			if (this.config.model == "TF" && scpCmd.Type == 'scene') {
				valParams = {type: 'dropdown', label: scpLabels[scpLabelIdx], id: 'Y', default: 'a', choices:[
					{id: 'a', label: 'A'},
					{id: 'b', label: 'B'}
				]}
			} else {
				valParams = {type: 'number', label: scpLabels[scpLabelIdx], id: 'Y', min: 1, max: scpCmd.Y, default: 1, required: true, range: false}
			}

			newAction.options.push(valParams);
		}
		
		if (scpLabelIdx < scpLabels.length - 1) {
			scpLabelIdx++;
		}

		switch(scpCmd.Type) {
			case 'integer':
				if (scpCmd.Max == 1) { // Boolean?
					valParams = {type: 'dropdown', label: 'State', id: 'Val', default: scpCmd.Default, minChoicesForSearch: 0, choices: [
						{label: 'On', id:1}, {label: 'Off', id:0}, {label: 'Toggle', id:'Toggle'}
					]}
				} else {
					valParams = {
						type: 'number', label: scpLabels[scpLabelIdx], id: 'Val', min: scpCmd.Min, max: scpCmd.Max, default: parseInt(scpCmd.Default), required: true, range: false
					}
				}
				break;
			case 'string':
			case 'binary':
				if (scpLabel.startsWith("CustomFaderBank")) {
					valParams = {type: 'dropdown', label: scpLabels[scpLabelIdx], id: 'Val', default: scpCmd.Default, minChoicesForSearch: 0, choices: scpNames.customChNames}
				} else if (scpLabel.endsWith("Color")) {
					valParams = {type: 'dropdown', label: scpLabels[scpLabelIdx], id: 'Val', default: scpCmd.Default, minChoicesForSearch: 0, 
					choices: this.config.model == "TF" ? scpNames.chColorsTF : scpNames.chColors}
				} else if (scpLabel.endsWith("Icon")) {
					valParams = {type: 'dropdown', label: scpLabels[scpLabelIdx], id: 'Val', default: scpCmd.Default, minChoicesForSearch: 0, 
					choices: scpNames.chIcons}
				} else if (scpLabel == "DanteOutPort/Patch") {
					valParams = {type: 'dropdown', label: scpLabels[scpLabelIdx], id: 'Val', default: scpCmd.Default, minChoicesForSearch: 0, 
					choices: scpNames.danteOutPatch}
				} else if (scpLabel == "OmniOutPort/Patch") {
					valParams = {type: 'dropdown', label: scpLabels[scpLabelIdx], id: 'Val', default: scpCmd.Default, minChoicesForSearch: 0, 
					choices: scpNames.omniOutPatch}

				} else {
					valParams = {type: 'textinput', label: scpLabels[scpLabelIdx], id: 'Val', default: scpCmd.Default, regex: ''}
				}
				break;
			default:
				return newAction;
		}
			
		newAction.options.push(valParams);
		return newAction;
		
	}

	
	// Create the Actions & Feedbacks
	actions(system) {
		
		let commands  = {};
		let feedbacks = {};
		let command   = {};
		let scpAction = '';

		for (let i = 0; i < this.scpCommands.length; i++) {

			command = this.scpCommands[i]
			scpAction = command.Address.replace(/:/g, "_");
		
			commands[scpAction] = this.createAction(command);
			feedbacks[scpAction] = JSON.parse(JSON.stringify(commands[scpAction])); // Clone the Action to a matching feedback

			if (this.nameCommands.includes(scpAction) || this.colorCommands.includes(scpAction)) {
				feedbacks[scpAction].type = 'advanced'; // New feedback style
				feedbacks[scpAction].options.pop();
			} else {
				feedbacks[scpAction].type = 'boolean'; // New feedback style

				if (feedbacks[scpAction].options.length > 0) {
					let lastOptions = feedbacks[scpAction].options[feedbacks[scpAction].options.length - 1]
					if (lastOptions.label == 'State') {
						lastOptions.choices.pop(); // Get rid of the Toggle setting for Feedbacks
					}
				}

				feedbacks[scpAction].style = {color: this.rgb(0,0,0), bgcolor: this.rgb(255,0,0)};
			}
		}

		commands['macroRecStart'] = {label: 'Record SCP Macro'};
		commands['macroRecLatch'] = {label: 'Record SCP Macro (latched)'}
		commands['macroUnLatch'] = {label: 'Unlatch SCP Macro'};
		feedbacks['macro'] = {label: 'Macro Feedback', type: 'advanced', options: [
			{type: 'dropdown', label: 'Mode', id: 'mode', choices: [
				{id: 'r', label: 'Record'},
				{id: 'rl', label: 'Record Latch'},
				{id: 's', label: 'Stop'}]
			},			
			{type: 'colorpicker', label: 'Color', id: 'fg', default: this.rgb(0,0,0)},
			{type: 'colorpicker', label: 'Background', id: 'bg', default: this.rgb(255,0,0)}
		]};


this.log('info','******** COMMAND LIST *********');
Object.entries(commands).forEach(([key, value]) => this.log('info',`${value.label.padEnd(36, '\u00A0')} ${key}`));
this.log('info','***** END OF COMMAND LIST *****')


		this.setActions(commands);
		this.setFeedbackDefinitions(feedbacks);
	}

	
	// Create the proper command string for an action or poll
	parseCmd(prefix, scpCmd, opt) {
		
		if (scpCmd == undefined || opt == undefined) return;

		let scnPrefix  = '';
		let optX       = (opt.X === undefined) ? 1 : (opt.X > 0) ? opt.X : this.config[`myCh${-opt.X}`];
		let optY       = (opt.Y === undefined) ? 0 : opt.Y - 1;
		let optVal
		let scpCommand = this.scpCommands.find(cmd => cmd.Address.replace(/:/g, "_") == scpCmd);

		if (scpCommand == undefined) {
			this.log('debug',`PARSECMD: Unrecognized command. '${scpCmd}'`)
			return;
		} 
		let cmdName = scpCommand.Address;			
		
		switch(scpCommand.Type) {
			case 'integer':
			case 'binary':
				cmdName = `${prefix} ${cmdName}`
				if (opt.Val == 'Toggle') {
					if (this.dataStore[scpCmd] !== undefined && this.dataStore[scpCmd][optX] !== undefined) {
						optVal = ((prefix == 'set') ? 1 - parseInt(this.dataStore[scpCmd][optX][optY + 1]) : '');
					}					
				} else {
					optVal = ((prefix == 'set') ? opt.Val : ''); 	// if it's not "set" then it's a "get" which doesn't have a Value
				}
				optX--; // ch #'s are 1 higher than the parameter
				break;
			
			case 'string':
				cmdName = `${prefix} ${cmdName}`
				optVal = ((prefix == 'set') ? `"${opt.Val}"` : ''); // quotes around the string
				optX--; // ch #'s are 1 higher than the parameter except with Custom Banks
				break;
	
			case 'scene':
				optY = '';
				optVal = '';
	
				if (prefix == 'set') {
					scnPrefix = 'ssrecall_ex';
					this.pollScp();		// so buttons with feedback reflect any changes
				} else {
					scnPrefix = 'sscurrent_ex';
					optX = '';
				}
	
				if (this.config.model == 'CL/QL') {
					cmdName = `${scnPrefix} ${cmdName}`;  		 // Recall Scene for CL/QL
				} else {
					cmdName = `${scnPrefix} ${cmdName}${opt.Y}`; // Recall Scene for TF
				}
		}		
		
		return `${cmdName} ${optX} ${optY} ${optVal}`.trim(); 	 // Command string to send to console
	}

	
	// Create the preset definitions
	presets() {
		this.scpPresets = [{
			category: 'Macros',
			label: 'Create SCP Macro',
			bank: {
				style: 			'png',
				text: 			'Record SCP Macro',
				png64: 			this.ICON_REC_INACTIVE,
				pngalignment:	'center:center',
				latch: 			false,
				size: 			'auto',
				color: 			this.rgb(255,255,255),
				bgcolor: 		this.rgb(0,0,0)
			},
			actions: 			[{action: 'macroRecStart'}, {action: 'macroRecLatch', delay: 500}],
			release_actions: 	[{action: 'macroUnLatch'}],
			feedbacks: [
				{type: 'macro', options: {'mode': 'r', fg: this.rgb(0,0,0), bg: this.rgb(255,0,0)}},
				{type: 'macro', options: {'mode': 'rl', fg: this.rgb(0,0,0), bg: this.rgb(255,255,0)}}//,
			]
		}];
		
		this.setPresetDefinitions(this.scpPresets);
	}

	
	// Add a command to a Macro Preset
	addMacro(c) {

		let foundActionIdx = -1;

		if (this.macroRec) {
			let cX = parseInt(c.cmd.X);
			let cY = parseInt(c.cmd.Y);
			let cV

			switch(c.scp.Type) {
				case 'integer':
				case 'binary':
					cX++;
					cY++;
					cV = parseInt(c.cmd.Val);
					break;
				case 'string':
					cX++;
					cY++;
					cV = c.cmd.Val;
			}
			
			// Check for new value on existing action
			let scpActions = this.macro.actions;
			if (scpActions !== undefined) {
				foundActionIdx = scpActions.findIndex(cmd => (
					cmd.action == c.scp.Address.replace(/:/g, "_") && 
					cmd.options.X == cX &&
					cmd.options.Y == cY
				));
			}
			
			if (foundActionIdx == -1) {
				scpActions.push([]);
				foundActionIdx = scpActions.length - 1;
			}

			scpActions[foundActionIdx] = {action: c.scp.Address.replace(/:/g, "_"), options: {X: cX, Y: cY, Val: cV}};

		}
	}

	dropMacro(preset, button) {
        
		if (preset.actions == undefined) {
			return;
		}
		
		preset.release_actions = [];
		preset.feedbacks = [];

		for (var i = 0; i < preset.actions.length; ++i) {
			preset.actions[i].id        = shortid.generate();
			preset.actions[i].instance  = this.id;
			preset.actions[i].label     = this.id + ':' + preset.actions[i].action;

			preset.feedbacks.push(
				{
					id:          shortid.generate(),
					instance_id: this.id,
					type:        'boolean', // preset.actions[i].action,
					options:     {...preset.actions[i].options},
					style:		 {color: this.rgb(0,0,0), bgcolor: this.rgb(255,0,0)}
				}
			)

			let scpCommand = this.scpCommands.find(cmd => cmd.Address.replace(/:/g, "_") == preset.actions[i].action);

			if (scpCommand != undefined && scpCommand.Type == 'integer' && scpCommand.Max == 1) {
				preset.actions[i].options.Val = 'Toggle';				
			}

		}

		bank_actions[button.page][button.bank].pop();	// For some reason this is necessary...
		preset.config = preset.bank
		delete preset.bank
		this.system.emit('import_bank', button.page, button.bank, preset);
		
	}

	// Handle the Actions
	action(action, button) {

//console.log(action);

		if (!action.action.startsWith('macro')) { // Regular action
			let cmd = this.parseCmd('set', action.action, action.options);
			if (cmd !== undefined) {
				this.log('debug', `Sending : '${cmd}' to ${this.config.host}`);

				if (this.socket !== undefined && this.socket.connected) {
					this.socket.send(`${cmd}\n`); 	// send it, but add a CR to the end
				}
				else {
					this.log('info', 'Socket not connected :(');
				}
			}	
		} else { // Macro
			switch (action.action) {
				case 'macroRecStart':

					if (!this.macroRec) {
						this.macroRec = true;
						this.macroMode = '';
						this.macroCount++;
						this.macro = {
							label: `Macro ${this.macroCount}`,
							bank: {
								style: 'text',
								text: `Macro ${this.macroCount}`,
								size: 'auto',
								color: this.rgb(255,255,255),
								bgcolor: this.rgb(0,0,0)
							},
							actions: []
						};

					} else {
//console.log('Stopped.');
						this.macroRec = false;
						if (this.macro.actions.length > 0) {
							this.dropMacro(this.macro, button);
						} else {
							this.macroCount--;
						}
						this.macroMode = 'stopped';
					}
					break;

				case 'macroRecLatch':

					if (this.macroMode == '') {
						this.macroMode = 'latch';
					}
					break;

				case 'macroUnLatch':

					if (this.macroMode == '') {
						this.macro.bank.latch = false;
						this.macroMode = 'one-shot';
					}
						
			}
		}

		this.checkFeedbacks('macro');

	}
	

	// Handle the Feedbacks
	feedback(feedback, bank) {

		let options     = feedback.options;
		let scpCommand  = this.scpCommands.find(cmd => cmd.Address.replace(/:/g, "_") == feedback.type);
		let retOptions  = {};

		if (scpCommand !== undefined) {
			let optVal = (options.Val == undefined) ? options.X : options.Val;
			let optX = (options.X > 0) ? options.X : this.config[`myCh${-options.X}`];
			let optY = (options.Y == undefined) ? 1 : options.Y;
						
//console.log(`\nFeedback: '${feedback.id}' from bank '${bank.text}' is ${feedback.type} (${scpCommand.Address})`);
//console.log(`X: ${optX}, Y: ${optY}, Val: ${optVal}`);

			if (this.dataStore[feedback.type] !== undefined && this.dataStore[feedback.type][optX] !== undefined) {
				
				if (this.dataStore[feedback.type][optX][optY] == optVal) {
//console.log('  *** Match ***');				
					return true;	

				} else {

					if (this.colorCommands.includes(feedback.type)) {
						let c = scpNames.chColorRGB[this.dataStore[feedback.type][optX][optY]]
						retOptions.color   = c.color;
						retOptions.bgcolor = c.bgcolor;
//console.log(`  *** Match *** (Color) ${JSON.stringify(retOptions)}\n`);
						return retOptions;
					}
					if (this.nameCommands.includes(feedback.type)) {
						retOptions.text = this.dataStore[feedback.type][optX][optY];
//console.log(`  *** Match *** (Text) ${JSON.stringify(retOptions)}\n`);
						return retOptions;
					}
				}
			}

			return false;

		}
//console.log(`macroMode: ${this.macroMode}, macroRec: ${this.macroRec}`);		
		if (feedback.type == 'macro' && this.macroRec) {
			if (this.macroMode == 'latch') {
				return {color: this.rgb(0,0,0), bgcolor: this.rgb(255,255,0), text: 'REC'};
			} else {
				return {color: this.rgb(0,0,0), bgcolor: this.rgb(255,0,0), text: 'REC'};
			}
		}

		return;
	}


	// Poll the console for it's status to update buttons via feedback

	pollScp() {
		let allFeedbacks = this.getAllFeedbacks();
		for (let fb in allFeedbacks) {
			let cmd = this.parseCmd('get', allFeedbacks[fb].type, allFeedbacks[fb].options);
			if (cmd !== undefined && this.id == allFeedbacks[fb].instance_id) {
				this.log('debug', `Sending : '${cmd}' to ${this.config.host}`);
				this.socket.send(`${cmd}\n`)
			}				
		}
	}


	addToDataStore(cmd) {
		let idx = cmd.scp.Index;
		let dsAddr = cmd.scp.Address.replace(/:/g, "_");
		let iY;
		
		if (cmd.cmd.Val == undefined) {
			cmd.cmd.Val = parseInt(cmd.cmd.X);
			cmd.cmd.X = undefined;
		}
		
		cmd.cmd.X = (cmd.cmd.X == undefined) ? 0 : cmd.cmd.X;
		let iX = parseInt(cmd.cmd.X) + 1;
		
		if (this.config.model == 'TF' && idx == 1000) {
			iY = cmd.cmd.Address.slice(-1)
		} else {
			cmd.cmd.Y = (cmd.cmd.Y == undefined) ? 0 : cmd.cmd.Y;
			iY = parseInt(cmd.cmd.Y) + 1;
		}

		if (this.dataStore[dsAddr] == undefined) {
			this.dataStore[dsAddr] = {};
		}
		if (this.dataStore[dsAddr][iX] == undefined) {
			this.dataStore[dsAddr][iX] = {};
		}
		this.dataStore[dsAddr][iX][iY] = cmd.cmd.Val;

//console.log(this.dataStore)
	}


}

exports = module.exports = instance;