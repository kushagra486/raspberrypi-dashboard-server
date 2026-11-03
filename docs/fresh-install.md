# Fresh, headless install of the Pi

No monitor or keyboard needed. Everything is configured from the laptop while
flashing the SD card, and the Pi is reached over SSH from the first boot.

> **Flashing erases the SD card.** Copy off anything you want to keep first
> (old project files, an old Supabase `.env` or database). The pendrive is not
> touched by flashing.

## 1. SSH key on the laptop (once)

Skip if you already have `~/.ssh/id_ed25519.pub`. Works in macOS/Linux
terminals and Windows PowerShell:

```bash
ssh-keygen -t ed25519 -C "kushagra-laptop"
```

This is your **personal** key. The separate, revocable key for AI agents is
created later (Layer 2).

## 2. Flash with Raspberry Pi Imager

Install Raspberry Pi Imager on the laptop (raspberrypi.com/software), then:

1. **Device:** Raspberry Pi 5.
2. **OS:** Raspberry Pi OS (other) → **Raspberry Pi OS Lite (64-bit)**. Lite has
   no desktop, which saves RAM for Supabase.
3. **Storage:** the SD card.
4. When asked about OS customisation, choose **Edit settings**:
   - **Hostname:** `pi` (reachable as `pi.local`)
   - **Username / password:** your username, plus a strong password (needed for `sudo`)
   - **Wireless LAN:** your Wi-Fi name, password and country. Skip if you will
     use an Ethernet cable (recommended for a server).
   - **Locale:** your time zone (cron backups run at 03:30 local time)
   - **Services → Enable SSH → Allow public-key authentication only**, and
     paste the contents of `~/.ssh/id_ed25519.pub`
5. Write the card.

## 3. Optional, before first boot: 4K page-size kernel

The Pi 5's default kernel uses 16K memory pages, which some jemalloc-based
software cannot run on. While the card is still in the laptop, open the boot
partition (named `bootfs`), and add this line at the end of `config.txt`:

```
kernel=kernel8.img
```

This costs a little Pi 5-specific performance and avoids a class of container
crashes. Remove the line to go back.

## 4. First boot and login

Put the card in the Pi, plug in the pendrive (and Ethernet if used), then power
on. Give it 1-2 minutes, then from the laptop:

```bash
ssh <username>@pi.local
```

If `pi.local` does not resolve (some Windows/router setups), find the Pi's IP
in your router's connected-devices page and use `ssh <username>@<ip>`.

Then:

```bash
sudo apt update && sudo apt full-upgrade -y && sudo reboot
```

## 5. Next

```bash
sudo apt install -y git
git clone https://github.com/kushagra486/raspberrypi-dashboard-server.git
cd raspberrypi-dashboard-server
bash scripts/00-inspect.sh 2>&1 | tee inspect-report.txt
```

Share the report, then continue with `supabase/` (Layer 1).
