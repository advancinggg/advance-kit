#!/bin/sh
input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // "Unknown Model"')

# ANSI colors
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
BLUE="\033[34m"
MAGENTA="\033[35m"
DIM="\033[2m"
RESET="\033[0m"

# Bar color: green < 70%, yellow 70-85%, red >= 85%
bar_color() {
  if [ $1 -ge 85 ]; then printf "%b" "$RED"
  elif [ $1 -ge 70 ]; then printf "%b" "$YELLOW"
  else printf "%b" "$GREEN"
  fi
}

# Progress bar: filled (colored) + empty (dim), width=10
bar() {
  pct=$1
  color_fn=$2
  width=10
  [ $pct -gt 100 ] && pct=100
  filled=$(( (pct * width + 50) / 100 ))
  [ "$pct" -gt 0 ] && [ $filled -eq 0 ] && filled=1
  empty=$((width - filled))

  color=$($color_fn $pct)
  b="${color}"
  i=0; while [ $i -lt $filled ]; do b="${b}█"; i=$((i+1)); done
  b="${b}${DIM}"
  i=0; while [ $i -lt $empty  ]; do b="${b}░"; i=$((i+1)); done
  b="${b}${RESET}"
  printf "%b" "$b"
}

# Countdown: resets_at is Unix epoch seconds
countdown() {
  reset_epoch=$(echo "$input" | jq -r "$1 // empty")
  [ -z "$reset_epoch" ] && return
  now=$(date +%s)
  diff=$((reset_epoch - now))
  [ $diff -le 0 ] && { printf "now"; return; }
  d=$((diff / 86400))
  h=$(( (diff % 86400) / 3600 ))
  m=$(( (diff % 3600) / 60 ))
  if [ $d -gt 0 ]; then
    printf "%dd %dh %02dm" $d $h $m
  elif [ $h -gt 0 ]; then
    printf "%dh %02dm" $h $m
  else
    printf "%dm" $m
  fi
}

# Context
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
if [ -n "$used" ]; then
  used_int=$(printf "%.0f" "$used")
  ctx_str="Context $(bar $used_int bar_color) ${used_int}%"
else
  ctx_str="Context $(printf "%b" "${DIM}░░░░░░░░░░${RESET}") --"
fi

# 5-hour rate limit (Session Limits)
five=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
if [ -n "$five" ]; then
  five_int=$(printf "%.0f" "$five")
  five_cd=$(countdown '.rate_limits.five_hour.resets_at')
  if [ -n "$five_cd" ]; then
    five_str="Session Limits (◷ ${five_cd}) $(bar $five_int bar_color) ${five_int}%"
  else
    five_str="Session Limits $(bar $five_int bar_color) ${five_int}%"
  fi
else
  five_str=""
fi

# 7-day rate limit (Weekly Limits)
week=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
if [ -n "$week" ]; then
  week_int=$(printf "%.0f" "$week")
  week_cd=$(countdown '.rate_limits.seven_day.resets_at')
  if [ -n "$week_cd" ]; then
    week_str="Weekly Limits (◷ ${week_cd}) $(bar $week_int bar_color) ${week_int}%"
  else
    week_str="Weekly Limits $(bar $week_int bar_color) ${week_int}%"
  fi
else
  week_str=""
fi

# Token usage
in_tok=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
out_tok=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')
cache_write=$(echo "$input" | jq -r '.context_window.current_usage.cache_creation_input_tokens // 0')
cache_read=$(echo "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0')

# Format token count: 1234 -> 1.2k, 12345 -> 12.3k, 123456 -> 123k
fmt_tok() {
  n=$1
  if [ "$n" -ge 1000000 ]; then
    printf "%d.%dM" $((n / 1000000)) $(( (n % 1000000) / 100000 ))
  elif [ "$n" -ge 100000 ]; then
    printf "%dk" $((n / 1000))
  elif [ "$n" -ge 1000 ]; then
    printf "%d.%dk" $((n / 1000)) $(( (n % 1000) / 100 ))
  else
    printf "%d" "$n"
  fi
}

token_str="↑$(fmt_tok $in_tok) ↓$(fmt_tok $out_tok) ⊕$(fmt_tok $cache_write) ↺$(fmt_tok $cache_read)"

line1="$ctx_str"
[ -n "$five_str" ] && line1="$line1  $five_str"
[ -n "$week_str" ] && line1="$line1  $week_str"

printf "%b\n%s │ %s" "$line1" "$model" "$token_str"
