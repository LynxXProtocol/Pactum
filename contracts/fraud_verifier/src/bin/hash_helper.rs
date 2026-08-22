use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use light_poseidon_nostd::{Poseidon, PoseidonHasher};

fn decode_hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: hash_helper <num_inputs> <hex_input_1> ...");
        std::process::exit(1);
    }
    let num_inputs = args[1].parse::<usize>().unwrap();
    let mut poseidon = Poseidon::<Fr>::new_circom(num_inputs).unwrap();
    
    let mut inputs = vec![];
    for i in 0..num_inputs {
        let bytes = decode_hex(&args[2+i]);
        inputs.push(Fr::from_be_bytes_mod_order(&bytes));
    }
    let hash = poseidon.hash(&inputs).unwrap();
    let bytes = hash.into_bigint().to_bytes_be();
    let hex_str: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    println!("{}", hex_str);
}
