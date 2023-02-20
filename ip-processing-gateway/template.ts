import { video_ref, time_ref, audio_ref } from "vutil";
import * as VAPI from "vapi";
import {
   VSocketParameters,
   Duration,
   asyncIter,
   asyncZip,
   enforce,
   enforce_nonnull,
} from "vscript";
import { collect_rtp_interfaces } from "vutil/network.js";
import { lock_to_genlock } from "vutil/rtp_receiver.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { readFileSync } from "fs";

function ensure_nonnull<T>(x: null | undefined | T, msg_if_not: string): T {
   if (x === null || x === undefined) {
      process.stderr.write("Error: " + msg_if_not + "\n");
      process.exit(1);
   }
   return x;
}

/*
 * Configures IO half in half out if applicable
 * returns [sdi_in, sdi_out]
 */

async function setup_IO(blade: VAPI.VM.Any) {
   console.log(`Blade @${blade.raw.ip} setting up SDI IO`);
   const io_type = ensure_nonnull(
      await blade.system.io_board.info.type.read(),
      "no IO module has been found; could you please plug one in and try again?"
   );
   console.log(`Blade @${blade.raw.ip} found IO Board ${io_type.toString()}`);
   enforce(!!blade.genlock, "Genlock software seems to be offline, aborting.");
   enforce(
      !!blade.i_o_module,
      "IO Module software seems to be offline, aborting."
   );
   const genlock =
      blade instanceof VAPI.AT1130.Root
         ? blade.genlock.instances.row(0).output
         : blade.genlock.output;
   enforce(!!genlock);
   switch (io_type) {
      case "IO_BNC_18_2":
      case "IO_BNC_10_10":
      case "IO_BNC_11_11":
      case "IO_BNC_2_18":
      case "IO_BNC_16_16":
         break;
      case "IO_MSC_v2":
      case "IO_BNC_16bidi":
      case "IO_BNC_2_2_16bidi":
         {
            const conf = await blade.i_o_module.configuration.rows();
            await asyncIter(conf, async (slot, i) => {
               let dir: VAPI.IOModule.ConfigDirection =
                  i < conf.length / 2 ? "Input" : "Output";
               await slot.direction.write(dir, {
                  retry_until: {
                     criterion: "custom",
                     validator: async () => {
                        switch (dir) {
                           case "Input":
                              return await enforce_nonnull(
                                 blade.i_o_module
                              ).input.is_allocated(i);
                           case "Output":
                              return await enforce_nonnull(
                                 blade.i_o_module
                              ).output.is_allocated(i);
                        }
                     },
                  },
               });
            });
         }
         break;
   }
   const sdi_in = await blade.i_o_module.input.rows();
   const sdi_out = await blade.i_o_module.output.rows();
   await asyncIter(sdi_in, async (io) => {
      if (blade instanceof VAPI.AT1130.Root)
         await io.audio_timing.command.write({
            variant: "SynchronousOrSyntonous",
            value: {
               frequency: "F48000",
               genlock: blade.genlock!!.instances.row(0),
            },
         });
      await io.mode.command.write("SDI");
   });
   await asyncIter(sdi_out, async (io) => {
      await io.mode.command.write("SDI");
      await io.sdi.t_src.command.write(genlock);
      await io.sdi.vanc_control.passthrough_c_y_0.command.write({
         c_unknown: true,
         y_obs: true,
         y_334_vbi: true,
         y_2020_amd: true,
         y_334_data: true,
         y_334_cea_608: true,
         y_rdd_8_op_47: true,
         y_334_cea_708_cdp: true,
         y_2010_ansi_scte_104: true,
         y_2031_dvb_scte_vbi: true,
         y_334_program: true,
         y_unknown: true,
      });
      await io.sdi.vanc_control.timecode_inserter.command.write({
         variant: "Passthrough",
         value: {},
      });
   });
   return [sdi_in, sdi_out];
}

interface MCastAddresses {
   video_prim: string[];
   video_sec: string[];

   meta_prim: string[];
   meta_sec: string[];

   audio_prim: string[];
   audio_sec: string[];
}

interface PTPParameters {
   domain: number;
   delay_req_interval?: number;
}

interface templateParameters {
   VSocketPars: VSocketParameters;
   PTP: PTPParameters;
   mcast_addresses: MCastAddresses;
}

function calc_mcast_schema(ip: string): MCastAddresses {
   const bytes = ip.split(".");
   const result: MCastAddresses = {
      video_prim: [],
      video_sec: [],

      meta_prim: [],
      meta_sec: [],

      audio_prim: [],
      audio_sec: [],
   };
   let type = 0;
   // TODO: check if this is correct, not sure if it might pick up hidden object properties?
   for (const key of Object.keys(result) as Array<keyof MCastAddresses>) {
      for (let i = 0; i < 254; ++i) {
         let str = `239.${bytes[2]}.${type}.${i}:9000`;
         result[key].push(str);
      }
      type++;
   }
   return result;
}

async function setup(pars: templateParameters) {
   console.log("Trying to connect to " + pars.VSocketPars.ip);
   const blade = await VAPI.VM.open(pars.VSocketPars);
   console.log("Trying to reset " + pars.VSocketPars.ip);
   // ptp agents can't be deleted while port-bound; haven't checked yet if there are similar potential
   // difficulties further down below, so for now we'll just invest the extra minute or so to do a full reset
   await blade.raw.reset();
   // these modules are optional in principle (not present on the 40GbE pcap application), but should
   // always be present in the applications we're using here, so we'll just check that upfront and
   // tell the TypeScript compiler about it
   enforce(
      !!blade.genlock &&
      !!blade.i_o_module &&
      !!blade.re_play &&
      !!blade.r_t_p_receiver &&
      !!blade.r_t_p_transmitter &&
      !!blade.color_correction &&
      !!blade.audio_gain,
      "Some software modules required for this template seems to be offline. Make sure the proper application is loaded or check the logs."
   );

   console.log("Allocating PTP agents...");
   // Set up PTP Agents
   const ptp_enabled_interfaces = await blade.p_t_p_flows.ports.rows();
   const ptp_agents = await blade.p_t_p_flows.agents.ensure_allocated(
      ptp_enabled_interfaces.length,
      "exactly"
   );

   console.log("Set up PTP agents...");
   await asyncZip(ptp_enabled_interfaces, ptp_agents, async (ifc, agent) => {
      await agent.domain.command.write(pars.PTP.domain);
      if (pars.PTP.delay_req_interval != null)
         await agent.slave_settings.log2_delayreq_interval.command.write(
            pars.PTP.delay_req_interval
         );
      await agent.hosting_port.command.write(ifc);
      await agent.mode.write("SlaveOnly");
   });

   console.log("Set up Combinator...");
   // Set up Timeflows + Set PTPClock Input
   const combinator:
      | VAPI.AT1101.TimeFlows.CombinatorAsNamedTableRow
      | VAPI.AT1130.TimeFlows.CombinatorAsNamedTableRow = (
         await blade.time_flows.combinators.ensure_allocated(1, "exactly")
      )[0];
   await combinator.quorum.command.write(1);
   const t_src_entries = await combinator.t_src.status.read();
   t_src_entries.fill(null);
   ptp_agents.forEach((agent, i) => (t_src_entries[i] = agent.output));
   await combinator.t_src.command.write(t_src_entries);
   await blade.p_t_p_clock.t_src.command.write(combinator.output);
   await blade.p_t_p_clock.mode.write("LockToInput");

   if (blade instanceof VAPI.AT1130.Root) {
      await asyncIter([...blade.genlock.instances], async (instance) => {
         await instance.t_src.command.write(blade.p_t_p_clock.output);
      });
   }

   const GENLOCK =
      blade instanceof VAPI.AT1130.Root
         ? blade.genlock.instances.row(0).output
         : blade.genlock.output;

   console.log(`Blade @${blade.raw.ip} waiting for PTPClock to calibrate`);
   await blade.p_t_p_clock.state.wait_until((state) => state === "Calibrated", {
      // unfortunately this can take a very long time if your switches are slow
      // to serve igmp requests after link state changes
      timeout: new Duration(240, "s"),
   });
   console.log(`Blade @${blade.raw.ip} waiting for Genlock to calibrate`);
   if (blade instanceof VAPI.AT1130.Root) {
      await blade.genlock.instances
         .row(0)
         .lanes.video_f50_ish.wait_until((pars) => pars?.state === "Calibrated", {
            timeout: new Duration(60, "s"),
         });
      await blade.genlock.instances
         .row(0)
         .lanes.video_f59_ish.wait_until((pars) => pars?.state === "Calibrated", {
            timeout: new Duration(60, "s"),
         });
      await blade.genlock.instances
         .row(0)
         .lanes.audio.wait_until((pars) => pars?.state === "Calibrated", {
            timeout: new Duration(60, "s"),
         });
   } else {
      await blade.genlock.state.wait_until((state) => state === "Calibrated", {
         timeout: new Duration(60, "s"),
      });
   }

   //IO Module set up
   console.log(`Blade @${blade.raw.ip} setting up SDI IO`);
   await setup_IO(blade);
   const sdi_in = await blade.i_o_module.input.rows();
   const sdi_out = await blade.i_o_module.output.rows();
   console.log(`Blade @${blade.raw.ip} found ${sdi_in.length} SDI inputs`);
   //Set Up FrameSync TODO check amount

   const delays = await blade.re_play.video.delays.ensure_allocated(
      sdi_in.length,
      "exactly"
   );
   console.log(`Blade @${blade.raw.ip} allocated ${delays.length} delays`);
   await asyncZip(sdi_in, delays, async (io, delay) => {
      const is_12g = false;
      if ((await delay.num_outputs.read()) < 1) await delay.num_outputs.write(1);
      const input_mode: VAPI.VideoRePlay.InputMode = is_12g ? "UHD" : "Single";
      await delay.capabilities.input_mode.command.write(input_mode);
      await delay.outputs.row(0).output_mode.command.write(input_mode);
      await delay.capabilities.delay_mode.command.write("FrameSync_Freeze");
      await delay.capabilities.capacity.command.write({
         variant: "Frames",
         value: { frames: 1 },
      });
      await delay.outputs
         .row(0)
         .delay.offset.command.write({ variant: "Frames", value: { frames: 1 } });
      await delay.inputs.row(0).v_src.command.write(io.sdi.output.video);
   });

   console.log(`Blade @${blade.raw.ip} configured ${delays.length} delays`);
   const cc1d = await blade.color_correction.cc1d.ensure_allocated(
      delays.length,
      "exactly"
   );
   console.log(`Blade @${blade.raw.ip} allocated ${cc1d.length} cc1d instances`);
   await asyncZip(delays, cc1d, async (delay, cc) => {
      const is_12g =
         (await delay.capabilities.input_mode.status.read()) === "UHD";
      await cc.reserve_uhd_resources.command.write(is_12g);
      await cc.v_src.command.write(delay.outputs.row(0).video);

      // Set some defaults
      await cc.output_cs.write("BT709");
      await cc.rgb.active.command.write(true);

      await cc.rgb.red.gain.write(1);
      await cc.rgb.red.gamma.write(1);
      await cc.rgb.red.contrast.write(1);
      await cc.rgb.red.brightness.write(0);

      await cc.rgb.green.gain.write(1);
      await cc.rgb.green.gamma.write(1);
      await cc.rgb.green.contrast.write(1);
      await cc.rgb.green.brightness.write(0);

      await cc.rgb.blue.gain.write(1);
      await cc.rgb.blue.gamma.write(1);
      await cc.rgb.blue.contrast.write(1);
      await cc.rgb.blue.brightness.write(0);
   });
   console.log(
      `Blade @${blade.raw.ip} configured ${cc1d.length} cc1d instances`
   );

   // Set Up Transmitters
   if (
      pars.mcast_addresses &&
      Math.max(
         pars.mcast_addresses.video_prim.length,
         pars.mcast_addresses.video_sec.length,
         pars.mcast_addresses.meta_prim.length,
         pars.mcast_addresses.meta_sec.length,
         pars.mcast_addresses.audio_prim.length,
         pars.mcast_addresses.audio_sec.length
      ) < sdi_in.length
   ) {
      process.stderr.write(
         `Error: When specifying multicast addresses via a JSON schema file, please make sure every category contains at least as many entries as there are sdi inputs (currently ${sdi_in})`
      );
   }
   const tx_sessions = await blade.r_t_p_transmitter.sessions.ensure_allocated(
      sdi_in.length,
      "exactly"
   );
   const tx_videos =
      await blade.r_t_p_transmitter.video_transmitters.ensure_allocated(
         sdi_in.length,
         "exactly"
      );
   const tx_audios =
      await blade.r_t_p_transmitter.audio_transmitters.ensure_allocated(
         sdi_in.length,
         "exactly"
      );

   console.log(
      `Blade @${blade.raw.ip} allocated ${tx_sessions.length} tx sessions`
   );
   console.log(
      `Blade @${blade.raw.ip} allocated ${tx_videos.length} video_transmitters`
   );
   console.log(
      `Blade @${blade.raw.ip} allocated ${tx_audios.length} audio_transmitters`
   );

   const rtp_ifcs = ensure_nonnull(
      await collect_rtp_interfaces(blade),
      `Unable to find rtp-enabled interfaces at ${blade.raw.ip}; could you please make sure that at least one high-speed port is active, and has a valid (non-link-local) source address?`
   );

   await asyncZip(tx_sessions, sdi_in, async (session, sdi) => {
      await session.interfaces.command.write({
         primary: rtp_ifcs.primary[0] ?? null,
         secondary: rtp_ifcs.secondary[0] ?? null,
      });
      await session.session_name.description.command.write(
         `RTP Session for ${sdi.raw.kwl}`
      );
      await session.session_name.brief.command.write(
         `RTP-Transmitter-${sdi.raw.kwl}`
      );
   });
   console.log(
      `Blade @${blade.raw.ip} configured interfaces for ${tx_sessions.length} TX-Sessions`
   );

   await asyncZip(tx_sessions, tx_videos, async (session, video) => {
      try {
         await video.generic.hosting_session.command.write(session);
         await video.constraints.max_bandwidth.command.write("b3_0Gb");
         await video.configuration.transport_format.command.write({
            variant: "ST2110_20",
            value: {
               add_st2110_40: true,
               packing_mode: "GPM",
               transmit_scheduler_uhd: false,
            },
         });
         await video.generic.mediaclock.clock_mode.command.write({
            variant: "Timesource",
            value: { t_src: time_ref(GENLOCK) },
         });
         let caps = await video.configuration.vanc.passthrough_c_y_0.status.read();
         video.configuration.vanc.afd_inserter.write({
            variant: "Passthrough",
            value: {},
         });
         video.configuration.vanc.timecode_inserter.command.write({
            variant: "Passthrough",
            value: {},
         });
         caps.y_obs = true;
         caps.y_334_vbi = true;
         caps.y_2020_amd = true;
         caps.y_334_data = true;
         caps.y_334_cea_608 = true;
         caps.y_rdd_8_op_47 = true;
         caps.y_334_cea_708_cdp = true;
         caps.y_2010_ansi_scte_104 = true;
         caps.y_2031_dvb_scte_vbi = true;
         await video.configuration.vanc.passthrough_c_y_0.command
            .write(caps)
            .catch((err) => {
               console.log(`Writing VANC Settings might have failed ${err}`);
            });

         // Set mcast adresses
         await video.generic.ip_configuration.video.primary.dst_address.command.write(
            pars.mcast_addresses.video_prim[video.index]
         );
         await video.generic.ip_configuration.video.secondary.dst_address.command.write(
            pars.mcast_addresses.video_sec[video.index]
         );
         await video.generic.ip_configuration.meta.primary.dst_address.command.write(
            pars.mcast_addresses.meta_prim[video.index]
         );
         await video.generic.ip_configuration.meta.secondary.dst_address.command.write(
            pars.mcast_addresses.meta_sec[video.index]
         );
      } catch (e) {
         console.log(
            `Error while trying to set up TX session ${session.index}:`,
            e
         );
      }
   });

   await asyncZip(cc1d, tx_videos, (cc_instance, video_tx) =>
      video_tx.v_src.command.write(video_ref(cc_instance.output))
   );

   console.log(
      `Blade @${blade.raw.ip} configured ${tx_sessions.length} Video-Transmitters`
   );
   // Set Up audio gains and reset all gain/polarity settings
   const audio_gains = await blade.audio_gain.instances.ensure_allocated(
      sdi_in.length + sdi_out.length,
      "exactly"
   );
   const gain_in = audio_gains.slice(0, audio_gains.length / 2);
   const gain_out = audio_gains.slice(audio_gains.length / 2);
   await asyncZip(sdi_in, gain_in, async (sdi, gain) => {
      gain.a_src.command.write(sdi.sdi.output.audio);
      const levels = await gain.levels.read();
      levels.fill(0);
      await gain.levels.write(levels);

      const polarities = await gain.phase_inversion.read();
      polarities.fill(false);
      await gain.phase_inversion.write(polarities);
   });

   // Set up audio transmitters
   await asyncZip(tx_sessions, tx_audios, async (session, audio) => {
      await audio.generic.hosting_session.command.write(session);
      await audio.generic.mediaclock.clock_mode.command.write({
         variant: "Timesource",
         value: { t_src: time_ref(GENLOCK) },
      });
      await audio.configuration.transport_format.command.write({
         format: "L16",
         packet_time: "p0_125",
         num_channels: 16,
      }); // maybe go p_time 1ms 8 channels for lowest requirements

      // Set mcast adresses
      await audio.generic.ip_configuration.media.primary.dst_address.command.write(
         pars.mcast_addresses.audio_prim[audio.index]
      );
      await audio.generic.ip_configuration.media.secondary.dst_address.command.write(
         pars.mcast_addresses.audio_sec[audio.index]
      );
   });

   await asyncIter(tx_sessions, (session) => session.active.command.write(true));

   await asyncZip(audio_gains, tx_audios, async (gain, audio) => {
      await audio.a_src.command.write(audio_ref(gain.output));
   });

   console.log(
      `Blade @${blade.raw.ip} configured ${tx_audios.length} Audio-Transmitters`
   );

   //Set up Receivers
   const rx_sessions = await blade.r_t_p_receiver.sessions.ensure_allocated(
      sdi_out.length,
      "exactly"
   );
   const rx_video = await blade.r_t_p_receiver.video_receivers.ensure_allocated(
      sdi_out.length,
      "exactly"
   );
   const rx_audio = await blade.r_t_p_receiver.audio_receivers.ensure_allocated(
      sdi_out.length,
      "exactly"
   );

   try {
      await asyncIter(rx_sessions, async (sess) => {
         await sess.active.command.write(false);
         await sess.interfaces.command.write({
            primary: rtp_ifcs.primary[0] ?? null,
            secondary: rtp_ifcs.secondary[0] ?? null,
         });
      });

      await asyncZip(rx_sessions, rx_video, async (sess, rx) => {
         await rx.generic.hosting_session.command.write(sess);
         await rx.generic.timing.target.command
            .write({
               variant: "TimeSource",
               value: { t_src: time_ref(GENLOCK), use_rtp_timestamp: false },
            })
         await rx.generic.initiate_readout_on.command.write("FirstStreamPresent");
         await rx.media_specific.capabilities.command
            .write({
               read_speed: lock_to_genlock(rx),
               jpeg_xs_caliber: null,
               supports_2022_6: false,
               st2042_2_caliber: null,
               supports_2110_40: true,
               st2110_20_caliber: "ST2110_upto_3G",
               supports_clean_switching: true,
               supports_uhd_sample_interleaved: false,
            })
      });
   } catch (e) {
      console.log(e);
   }
   // Connect RTPReceiver to SDI out
   console.log(
      `Blade @${blade.raw.ip} configured ${rx_sessions.length} RTPReceiver Sessions`
   );

   console.log(
      `Blade @${blade.raw.ip} connecting ${rx_sessions.length} RTPReceiver Sessions to ${sdi_out.length} SDI Outputs`
   );
   await asyncZip(sdi_out, rx_video, async (sdi, rx) => {
      await sdi.sdi.v_src.command.write(
         video_ref(rx.media_specific.output.video)
      );
   });
   await asyncZip(rx_audio, rx_sessions, async (audio, sess) => {
      await audio.generic.hosting_session.command.write(sess);
      await audio.media_specific.capabilities.command.write({
         channel_capacity: 16,
         payload_limit: "AtMost1984Bytes",
         read_speed: lock_to_genlock(audio),
         supports_clean_switching: true,
      });
   });
   await asyncZip(rx_audio, gain_out, async (rx, gain) => {
      await gain.a_src.command.write(rx.media_specific.output.audio);
      const levels = await gain.levels.read();
      levels.fill(0);
      await gain.levels.write(levels);
      const polarities = await gain.phase_inversion.read();
      polarities.fill(false);
      await gain.phase_inversion.write(polarities);
   });
   await asyncZip(sdi_out, gain_out, async (sdi, a_gain) => {
      await sdi.a_src.command.write(audio_ref(a_gain.output));
   });

   await asyncZip(sdi_out, rx_sessions, async (sdi) => {
      try {
         await sdi.mode.command.write("SDI");
         await sdi.sdi.t_src.command.write(time_ref(GENLOCK));
         const embedded = await sdi.sdi.embedded_audio.status.read();
         embedded.fill("Embed");
         await sdi.sdi.embedded_audio.command.write(embedded);
      } catch (e) {
         console.log(e);
      }
   });
   console.log(
      `Blade @${blade.raw.ip} configured ${sdi_out.length} SDI Outputs`
   );
   await blade.close();
}

const parser = yargs(hideBin(process.argv)).options({
   target_ip: {
      type: "string",
      demandOption: true,
      desc: "IP Address of the blade that should be configured",
   },
   ptp_domain: { type: "number", default: 127, desc: "Desired PTP Domain" },
   mcast_addr_schema: {
      config: true,
      demandOption: false,
      desc: "Path to multicast address schema",
      type: "string",
   },
   user: {
      type: "string",
      demandOption: false,
      desc: "Username for http basic auth"
   },
   password: {
      type: "string",
      demandOption: false,
      desc: "Password for http basic auth"
   }
});
const args = await parser.argv;
if (args.ptp_domain < 0 || args.ptp_domain > 127) {
   process.stdout.write("PTP Domain must be between 0 and 127!\n");
   process.exit(1);
}

await setup({
   VSocketPars: {
      ip: args.target_ip, towel: "",
      login: (args.user == undefined || args.password == undefined) ? undefined : { user: args.user, password: args.password },
   },
   PTP: { domain: args.ptp_domain },
   mcast_addresses: !!args.mcast_addr_schema
      ? (JSON.parse(
         readFileSync(args.mcast_addr_schema, "utf-8")
      ) as MCastAddresses) // FIXME: no validation performed here
      : calc_mcast_schema(args.target_ip),
}); // TODO args
