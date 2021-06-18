module.exports = {

    getParams: ((config) => {
        const SCP_PARAMS = ['Ok', 'Command', 'Index', 'Address', 'X', 'Y', 'Min', 'Max', 'Default', 'Unit', 'Type', 'UI', 'RW', 'Scale'];
        var scpNames 		= require('./scpNames.json');

        let fname = '';
        let scpCommands;
        const FS  = require("fs");

        switch (config.model) {
        case 'CL/QL':
            fname = 'CL5 SCP Parameters-1.txt';
            break;
        case 'TF':
            fname = 'TF5 SCP Parameters-1.txt';
            break;
        case 'PM':
            fname = 'Rivage SCP Parameters-1.txt';
        }

        // Read the DataFile
        if (fname !== '') {
            let data = FS.readFileSync(`${__dirname}/${fname}`);
            scpCommands = module.exports.parseData(data, SCP_PARAMS);

            scpCommands.sort((a, b) => {  // Sort the commands
                let acmd = a.Address.slice(a.Address.indexOf("/") + 1);
                let bcmd = b.Address.slice(b.Address.indexOf("/") + 1);
                return acmd.toLowerCase().localeCompare(bcmd.toLowerCase());
            })

            for (let i = 0; i < 4; i++) {
                scpNames.chNames[i] = {id: `-${i+1}`, label: config[`myChName${(i+1)}`]};
            }
        }

       return scpCommands;

    }),

    parseData: ((data, params) => {
		
		let cmds    = [];
		let line    = [];
		const lines = data.toString().split("\x0A");
		
		for (let i = 0; i < lines.length; i++){
			// I'm not going to even try to explain this next line,
			// but it basically pulls out the space-separated values, except for spaces that are inside quotes!
			line = lines[i].match(/(?:[^\s"]+|"[^"]*")+/g)

			if (line !== null && (['OK','NOTIFY'].indexOf(line[0].toUpperCase()) !== -1)) {
				let scpCommand = {};
				
				for (var j = 0; j < line.length; j++){
					scpCommand[params[j]] = line[j].replace(/"/g,'');  // Get rid of any double quotes around the strings
				}

				cmds.push(scpCommand); 

                if (params === module.exports.SCP_PARAMS) {
					let cmdArr = undefined;
					switch(scpCommand.Address.slice(-4)) {
						case 'Name':
							cmdArr = this.nameCommands;
							break;
						case 'olor':
							cmdArr = this.colorCommands;
					}
					if (cmdArr !== undefined) cmdArr.push(scpCommand.Address.replace(/:/g, "_"));
				}
			}		
		}
		return cmds
	})

}
